import * as amqp from "amqplib";

import {MessageQueueOptions} from "../options/coreServicesOptions";
import {Connection, Channel} from "amqplib";
import {IWorkerTaskExecutionAttributes} from "../data-model/taskExecution";
import {SchedulerHub} from "../schedulers/schedulerHub";
import {MetricsConnector} from "../data-access/metrics/metricsConnector";

const debug = require("debug")("pipeline:main-queue");

const TaskExecutionUpdateQueue = "TaskExecutionUpdateQueue";

export class MainQueue {
    private static instance: MainQueue = new MainQueue();

    private connection: Connection = null;
    private channel: Channel = null;

    public static get Instance() {
        return this.instance;
    }

    public async connect() {
        return new Promise(async (resolve) => {
            return this.connectToQueue(resolve);
        });
    }

    public async connectToQueue(resolve) {
        const url = `amqp://${MessageQueueOptions.host}:${MessageQueueOptions.port}`;

        debug(`main queue url: ${url}`);

        try {
            this.connection = await amqp.connect(url);

            this.channel = await this.connection.createChannel();

            this.connection.on("error", async (err) => {
                await this.connection.close();
                this.connection = null;
                this.channel = null;
                debug("connection error - reconnect in 5 seconds");
                debug(err);
                setInterval(() => this.connect(), 5000);
            });

            await this.channel.assertQueue(TaskExecutionUpdateQueue, {durable: true});

            await this.channel.prefetch(50);

            await this.channel.consume(TaskExecutionUpdateQueue, async (msg) => {
                try {
                    const taskExecution = JSON.parse(msg.content.toString());
                    const taskExecution2: IWorkerTaskExecutionAttributes = Object.assign({}, taskExecution, {
                        submitted_at: new Date(taskExecution.submitted_at),
                        started_at: new Date(taskExecution.started_at),
                        completed_at: new Date(taskExecution.completed_at)
                    });
                    await this.handleOneMessage(taskExecution2);
                    this.channel.ack(msg);
                } catch (err) {
                    debug(err);
                }
            }, {noAck: false});

            debug(`main queue ready`);

            resolve();

        } catch (err) {
            debug("failed to connect, retrying");
            debug(err);

            setTimeout(async () => this.connectToQueue(resolve), 15 * 1000);
        }
    }

    private async handleOneMessage(taskExecution: IWorkerTaskExecutionAttributes) {
        return new Promise((resolve) => {
            return this.acknowledgeMessage(taskExecution, resolve);
        });
    }

    private async acknowledgeMessage(taskExecution: IWorkerTaskExecutionAttributes, resolve) {
        debug("write metrics");
        await MetricsConnector.Instance().writeTaskExecution(taskExecution);

        debug("acknowledge message");
        const ack = await SchedulerHub.Instance.onTaskExecutionComplete(taskExecution);

        if (ack) {
            resolve();
            return true;
        } else {
            setTimeout(() => this.acknowledgeMessage(taskExecution, resolve), 10 * 1000);
        }

        return false;
    }
}
