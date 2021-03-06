import {PersistentStorageManager} from "../data-access/sequelize/databaseConnector";

const {performance} = require("perf_hooks");

const fse = require("fs-extra");
const path = require("path");
import * as _ from "lodash";

const debug = require("debug")("pipeline:scheduler:project-pipeline-scheduler");

const pipelineInputJsonFile = "pipeline-input.json";
const dashboardJsonFile = "dashboard.json";
const tileStatusJsonFile = "pipeline-storage.json";
const tileStatusLastJsonFile = tileStatusJsonFile + ".last";

import {
    BasePipelineScheduler, DefaultPipelineIdKey, TilePipelineStatus, IMuxTileLists
} from "./basePipelineScheduler";
import {IProject, IProjectAttributes, ProjectInputSourceState} from "../data-model/sequelize/project";
import {
    IPipelineTile, IPipelineTileAttributes,
    StageTableConnector
} from "../data-access/sequelize/project-connectors/stageTableConnector";
import {isNullOrUndefined} from "util";
import {ProjectDatabaseConnector} from "../data-access/sequelize/project-connectors/projectDatabaseConnector";
import {ServiceOptions} from "../options/serverOptions";
import {PipelineApiClient} from "../graphql/pipelineApiClient";

interface IPosition {
    x: number;
    y: number;
    z: number;
}

interface IJsonTile {
    id: number;
    relativePath: string;
    position: IPosition;
    step: IPosition;
    isComplete: boolean;
}

interface IDashboardTileContents {
    latticePosition: IPosition;
    latticeStep: IPosition;
}

interface IDashboardJsonTile {
    id: number;
    relativePath: string;
    contents: IDashboardTileContents;
    isComplete: boolean;
}

export class ProjectPipelineScheduler extends BasePipelineScheduler {

    public constructor(project: IProject) {
        super(project, project);

        this.IsExitRequested = false;

        this.IsProcessingRequested = true;
    }

    protected async createOutputStageConnector(connector: ProjectDatabaseConnector): Promise<StageTableConnector> {
        return await connector.connectorForProject(this._project);
    }

    protected async refreshTileStatus(): Promise<boolean> {
        // For the tile status stage (project "0" depth stage), refreshing the tile status _is_ the work.

        debug(`pipeline input update for project ${this._project.name}`);

        const knownInput = await this.performJsonUpdate();

        await this.refreshWithKnownInput(knownInput);

        return true;
    }

    protected async muxInputOutputTiles(knownInput: IPipelineTileAttributes[], knownOutput: IPipelineTile[]): Promise<IMuxTileLists> {
        const sorted: IMuxTileLists = {
            toInsert: [],
            toUpdate: [],
            toReset: [],
            toDelete: []
        };

        if (knownOutput.length - knownInput.length > 1000) {
            debug(`input has greater than 1000 fewer tiles than last check (${knownOutput.length - knownInput.length}) - skipping update`);
            return;
        }

        const toInsert: IPipelineTileAttributes[] = _.differenceBy(knownInput, knownOutput, DefaultPipelineIdKey);

        const toUpdate: IPipelineTileAttributes[] = _.intersectionBy(knownInput, knownOutput, DefaultPipelineIdKey);

        sorted.toDelete = _.differenceBy(knownOutput, knownInput, DefaultPipelineIdKey).map(t => t.relative_path);

        sorted.toInsert = toInsert.map(inputTile => {
            const now = new Date();

            return Object.assign({}, inputTile, {
                duration: 0,
                cpu_high: 0,
                memory_high: 0,
                created_at: now,
                updated_at: now
            });
        });

        let t0 = performance.now();

        const existingTilePaths = new Map<string, IPipelineTile>();

        knownOutput.map(t => existingTilePaths.set(t.relative_path, t));

        sorted.toUpdate = toUpdate.map<IPipelineTile>((inputTile: IPipelineTileAttributes) => {
            const existingTile = existingTilePaths.get(inputTile.relative_path);

            if (existingTile === null) {
                debug(`unexpected missing tile ${inputTile.relative_path}`);
                return null;
            }

            if (existingTile.prev_stage_status !== inputTile.this_stage_status) {
                existingTile.tile_name = inputTile.tile_name;
                existingTile.index = inputTile.index;
                existingTile.prev_stage_status = inputTile.prev_stage_status;
                existingTile.this_stage_status = inputTile.this_stage_status;
                existingTile.lat_x = inputTile.lat_x;
                existingTile.lat_y = inputTile.lat_y;
                existingTile.lat_z = inputTile.lat_z;
                existingTile.step_x = inputTile.step_x;
                existingTile.step_y = inputTile.step_y;
                existingTile.step_z = inputTile.step_z;
                existingTile.updated_at = new Date();

                return existingTile;
            } else {
                return null;
            }
        }).filter(t => t !== null);

        debug(`${this._project.name}: mux ${(performance.now() - t0).toFixed(3)} ms`);

        return sorted;
    }

    private async performJsonUpdate(): Promise<IPipelineTileAttributes[]> {
        let root = this._project.root_path;

        ServiceOptions.driveMapping.map(d => {
            if (root.startsWith(d.remote)) {
                root = d.local + root.slice(d.remote.length);
            }
        });

        if (!fse.existsSync(root)) {
            await PipelineApiClient.Instance().updateProject(this._project.id, ProjectInputSourceState.BadLocation);
            return [];
        }

        let dataFile = path.join(root, pipelineInputJsonFile);

        if (!fse.existsSync(dataFile)) {
            debug(`${pipelineInputJsonFile} does not exist in the project root path - moving on to ${dashboardJsonFile}`);

            dataFile = path.join(root, dashboardJsonFile);

            if (!fse.existsSync(dataFile)) {
                await PipelineApiClient.Instance().updateProject(this._project.id, ProjectInputSourceState.Missing);
                debug(`${dashboardJsonFile} also does not exist in the project root path ${dataFile} - skipping tile update`);
                return [];
            }

            await PipelineApiClient.Instance().updateProject(this._project.id, ProjectInputSourceState.Dashboard);
        } else {
            await PipelineApiClient.Instance().updateProject(this._project.id, ProjectInputSourceState.Pipeline);
        }

        let projectUpdate: IProjectAttributes = {
            id: this._project.id
        };

        let tiles: IProjectAttributes[];

        [projectUpdate, tiles] = await this.parsePipelineInput(dataFile, projectUpdate);

        let outputFile = path.join(root, tileStatusJsonFile);

        let backupFile = path.join(root, tileStatusLastJsonFile);

        if (fse.existsSync(outputFile)) {
            fse.copySync(outputFile, backupFile, {clobber: true});
        }

        if (fse.existsSync(outputFile)) {
            fse.unlinkSync(outputFile);
        }

        fse.outputJSONSync(outputFile, tiles);

        return tiles;
    }

    private async parsePipelineInput(dataFile: string, projectUpdate: IProjectAttributes): Promise<[IProjectAttributes, IPipelineTileAttributes[]]> {
        let contents = fse.readFileSync(dataFile);

        let jsonContent = JSON.parse(contents);

        if (!isNullOrUndefined(jsonContent.pipelineFormat)) {
            // Pipeline-specific input format.
            return this.parsePipelineDefaultInput(jsonContent, projectUpdate);
        } else {
            // Legacy direct dashboard input format.
            return this.parseDashboardInput(jsonContent, projectUpdate);
        }
    }

    private async parsePipelineDefaultInput(jsonContent: any, projectUpdate: IProjectAttributes): Promise<[IProjectAttributes, IPipelineTileAttributes[]]> {
        let tiles: IPipelineTileAttributes[] = [];

        if (jsonContent.extents) {
            projectUpdate.sample_x_min = jsonContent.extents.minimumX;
            projectUpdate.sample_x_max = jsonContent.extents.maximumX;
            projectUpdate.sample_y_min = jsonContent.extents.minimumY;
            projectUpdate.sample_y_max = jsonContent.extents.maximumY;
            projectUpdate.sample_z_min = jsonContent.extents.minimumZ;
            projectUpdate.sample_z_max = jsonContent.extents.maximumZ;

            await this._project.update(projectUpdate);

            this._project = await PersistentStorageManager.Instance().Projects.findById(this._project.id);
        }

        jsonContent.tiles.forEach((tile: IJsonTile) => {
            // Normalize paths to posix
            let normalizedPath = tile.relativePath.replace(new RegExp("\\" + "\\", "g"), "/");
            let tileName = path.basename(normalizedPath);
            let position = tile.position || {x: null, y: null, z: null};
            let step = tile.step || {x: null, y: null, z: null};

            tiles.push({
                relative_path: normalizedPath,
                index: isNullOrUndefined(tile.id) ? null : tile.id,
                tile_name: tileName || "",
                prev_stage_status: tile.isComplete ? TilePipelineStatus.Complete : TilePipelineStatus.Incomplete,
                this_stage_status: tile.isComplete ? TilePipelineStatus.Complete : TilePipelineStatus.Incomplete,
                lat_x: position.x,
                lat_y: position.y,
                lat_z: position.z,
                step_x: step.x,
                step_y: step.y,
                step_z: step.z,
            });
        });

        return [projectUpdate, tiles];
    }

    private async parseDashboardInput(jsonContent: any, projectUpdate: IProjectAttributes): Promise<[IProjectAttributes, IPipelineTileAttributes[]]> {
        let tiles: IPipelineTileAttributes[] = [];

        if (jsonContent.monitor.extents) {
            projectUpdate.sample_x_min = jsonContent.monitor.extents.minimumX;
            projectUpdate.sample_x_max = jsonContent.monitor.extents.maximumX;
            projectUpdate.sample_y_min = jsonContent.monitor.extents.minimumY;
            projectUpdate.sample_y_max = jsonContent.monitor.extents.maximumY;
            projectUpdate.sample_z_min = jsonContent.monitor.extents.minimumZ;
            projectUpdate.sample_z_max = jsonContent.monitor.extents.maximumZ;

            await this._project.update(projectUpdate);

            this._project = await PersistentStorageManager.Instance().Projects.findById(this._project.id);
        }

        for (let prop in jsonContent.tileMap) {
            if (jsonContent.tileMap.hasOwnProperty(prop)) {
                jsonContent.tileMap[prop].forEach((tile: IDashboardJsonTile) => {
                    // Normalize paths to posix
                    let normalizedPath = tile.relativePath.replace(new RegExp("\\" + "\\", "g"), "/");
                    let tileName = path.basename(normalizedPath);
                    let position = tile.contents.latticePosition || {x: null, y: null, z: null};
                    let step = tile.contents.latticeStep || {x: null, y: null, z: null};

                    tiles.push({
                        relative_path: normalizedPath,
                        index: isNullOrUndefined(tile.id) ? null : tile.id,
                        tile_name: tileName || "",
                        prev_stage_status: tile.isComplete ? TilePipelineStatus.Complete : TilePipelineStatus.Incomplete,
                        this_stage_status: tile.isComplete ? TilePipelineStatus.Complete : TilePipelineStatus.Incomplete,
                        lat_x: position.x,
                        lat_y: position.y,
                        lat_z: position.z,
                        step_x: step.x,
                        step_y: step.y,
                        step_z: step.z,
                    });
                });
            }
        }

        return [projectUpdate, tiles];
    }
}
