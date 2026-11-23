// const childProcess = require('child_process')
const cluster = require('cluster')
const path = require('path')
const { EventEmitter } = require('events')
const nconf = require('nconf')
const chalk = require('chalk')
// const _ = require('lodash')
const { logger } = require('../../logger')

function setupCluster(params) {
  cluster.setupMaster(
    Object.assign(
      {
        exec: path.join(__dirname, '../../http', './worker.js'),
      },
      params,
    ),
  )
}

class Workers {
  workersNumbers = 0 // workers numbers
  listeningPort = 8000 // workers listening port
  configFile = ''
  isDev = false // debug mode
  _workers = {} // store workers instance
  _respawnTimestamps = [] // 异常派生时间戳，用于频率限制
  shutdownRequested = false // 是否处于主动关闭流程
  env = {} // worker env
  /**
   * @typedef WorkersSettings
   * @type {object}
   * @property {number} workersNumber
   * @property {number} listeningPort
   */
  /**
   * Create a workers instance
   * @param {WorkersSettings} params
   * @returns {boolean|any}
   */
  constructor({ workersNumber, listeningPort }) {
    this.workersNumbers = workersNumber
    this.listeningPort = listeningPort
    this.configFile = nconf.get('config_file')
    this.isDev = !!nconf.get('dev')
    this.env = { dev: this.isDev, config_file: this.configFile }
    const _this = this
    this._workers = cluster.workers = new Proxy(
      {},
      {
        get(target, key, receiver) {
          return Reflect.get(target, key, receiver)
        },
        set(target, key, receiver) {
          _this._notifyWorkersChanged(receiver)
          return Reflect.set(target, key, receiver)
        },
      },
    ) // Hook cluster 的 worker 变量
    this.messagesHandler = new MessagesHandler(this._workers, workersNumber)
    setupCluster({})
  }

  _notifyWorkersChanged(newLength) {
    this.messagesHandler._notifyWorkersChanged(newLength)
  }

  registerMessageHandler(key, messageHandler) {
    this.messagesHandler.register(key, messageHandler)
  }

  get workers() {
    return this._workers
  }

  // Start workers
  async start() {
    logger.verbose(
      '[core.http.primary.Workers] %d workers will be spawned.',
      this.workersNumbers,
    )
    logger.info(
      '[core.http.primary.Workers] web server will listen on port: ' +
        chalk.yellow(this.listeningPort),
    )
    for (let i = 0; i < this.workersNumbers; i++) {
      this.spawnWorker()
    }
    logger.info('[core.http.primary.Workers] all workers are spawned.')
  }

  // 强制回收全部 worker，避免 master 退出后残留孤儿进程
  killAllWorkers() {
    this.shutdownRequested = true
    const workers = cluster.workers || {}
    const ids = Object.keys(workers)
    for (const id of ids) {
      try {
        workers[id].kill('SIGKILL')
      } catch (e) {
        // ignore
      }
    }
    if (ids.length > 0) {
      logger.warn(
        `[core.http.primary.Workers] force killed ${ids.length} worker(s) to avoid orphan processes.`,
      )
    }
    return ids.length
  }

  // 进入关闭流程：标记并回收全部 worker，避免退出过程中触发补派生
  prepareShutdown() {
    logger.verbose(
      '[core.http.primary.Workers] shutdown requested, stop respawning workers.',
    )
    this.killAllWorkers()
  }

  // 派生频率限制：单位时间内异常派生过多则放弃，交由 PM2 重启 master
  checkRespawnRate() {
    const windowMs = 60000
    const limit = Math.max(this.workersNumbers * 5, 10)
    const now = Date.now()
    this._respawnTimestamps = (this._respawnTimestamps || []).filter(
      (t) => now - t < windowMs,
    )
    if (this._respawnTimestamps.length >= limit) {
      logger.error(
        `[core.http.primary.Workers] workers exited unexpectedly ${
          this._respawnTimestamps.length
        } times within ${Math.round(
          windowMs / 1000,
        )}s, exceeded the limit(${limit}). Master will exit and let PM2 restart it.`,
      )
      return false
    }
    this._respawnTimestamps.push(now)
    return true
  }

  // Spawn Worker
  spawnWorker() {
    if (!this.checkRespawnRate()) {
      this.killAllWorkers()
      process.exit(1)
    }
    const worker = cluster.fork(this.env)
    logger.verbose(
      `[core.http.Primary.Workers] worker process(${chalk.yellow(
        'pid',
      )}: ${chalk.blue(worker.process.pid)}) is spawned.`,
    )
    // this._workers.push({ instance: worker, pid: worker.process.pid })
    // handle worker event
    worker.on('message', (message) => {
      message.from = worker.process.pid
      this.messageHandle(message)
    })
    worker.on('error', (err) => {
      logger.error(
        `[core.http.primary.Workers] worker process(${chalk.yellow(
          'pid',
        )}: ${chalk.blue(worker.process.pid)}) occur error: \n %s`,
        err.stack,
      )
    })
    worker.on('exit', this.handleExitEvent(worker.process.pid))
    // start server
    worker.send({
      key: 'start_server',
      data: {
        port: this.listeningPort,
      },
    })
  }

  notify(message) {
    for (const workerID in this._workers) {
      this._workers[workerID].send(message)
    }
  }

  // Handle worker messages
  messageHandle(message) {
    this.messagesHandler.handle(message)
  }

  // Handle Worker Exited event
  handleExitEvent(pid) {
    return (code, signal) => {
      if (code === null && !signal) {
        logger.error(
          `[core.http.primary.Workers] worker(${chalk.yellow(
            'pid',
          )}: ${chalk.blue(pid)}) is exited accidentally. Try to respawn it.`,
        )
        //  _.remove(this._workers, { pid })
        this.spawnWorker() // 重新生成工作进程
      } else if (code > 0) {
        // errors might be thrown
        const errMsg = `[core.http.primary.Workers] worker process(${chalk.yellow(
          'pid',
        )}: ${chalk.blue(
          pid,
        )}) exited with code: ${code}, master process exits to ensure the stability.`
        logger.error(errMsg)
        // 不再 throw：走 uncaughtException 链路会把其余 worker 遗留成孤儿进程（2026-11-22 事故）
        this.killAllWorkers()
        process.exit(1) // 交由 PM2 重启 master
      } else if (signal) {
        // exit ignore
        logger.info(
          `[core.http.primary.Workers] worker process(${chalk.yellow(
            'pid',
          )}: ${chalk.blue(
            pid,
          )})  is exited due to receiving a signal: ${chalk.blue(signal)}`,
        )
        // 非关闭流程下的信号退出（如被 OOM killer 发 SIGKILL）需要补派生，否则服务降级
        if (!this.shutdownRequested) {
          logger.warn(
            `[core.http.primary.Workers] worker exited by signal: ${chalk.blue(
              signal,
            )}, respawning it.`,
          )
          this.spawnWorker()
        }
      } // ignore exit code: 0
    }
  }
}

class MessagesHandler {
  /**
   * Build messagesHandler instance
   * @param {object} workers - cluster workers object
   * @param {number} configuredWorkersTarget
   * @returns {boolean|any}
   */
  constructor(workers, configuredWorkersTarget) {
    this.init = true
    this.workersTarget = configuredWorkersTarget
    this._workers = workers // Worker Instance maps
    this.messageEvent = new EventEmitter()
    this._handleMessageEvent(this.messageEvent)

    this.currentStartIndicator = 0
  }

  register(key, handler) {
    this.messageEvent.on(key, handler)
  }

  // default handle
  _handleMessageEvent(event) {
    event.on('started', async ({ from }) => {
      // worker started event
      logger.verbose(
        `[core.http.primary.Workers] worker process(${chalk.yellow(
          'pid',
        )}: ${chalk.blue(from)}) start handle requests.`,
      )
      this.currentStartIndicator++
      if (this.init && this.currentStartIndicator === this.workersTarget) {
        logger.info(
          `[core.http.primary.Workers] spawn ${this.workersTarget} workers successfully, and all workers start to handle requests.`,
        )
        if (process.send) {
          // test only
          process.send({
            key: 'started',
          })
        }
      }
    })
    event.on('error', (err) => {
      throw err
    })
  }

  _notifyWorkersChanged(newLength) {
    if (!this.init) {
      logger.verbose(
        '[core.http.primary.Workers] workers number changed, current: %d. configured: %d',
        this.workersTarget,
        newLength,
      )
    }
  }

  finishedInit() {
    this.init = false
  }

  handle(message) {
    this.messageEvent.emit(message.key, message)
  }
}

module.exports = {
  MessagesHandler,
  Workers,
}
