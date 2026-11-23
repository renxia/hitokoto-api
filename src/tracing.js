const Sentry = require('@sentry/node')
const Tracing = require('@sentry/tracing')
const {
  Dedupe: DedupeIntegration,
  ExtraErrorData: ExtraErrorDataIntegration,
  Transaction: TransactionIntegration,
} = require('@sentry/integrations')
const nconf = require('nconf')
const os = require('os')

// 遥测默认关闭，需在配置文件（telemetry.error / telemetry.performance）
// 或环境变量（如 telemetry.error=true）中显式开启
const isTelemetryErrorEnabled = !!nconf.get('telemetry:error')
const isTelemetryPerformanceEnabled = !!nconf.get('telemetry:performance')
const sentryDsn =
  isTelemetryErrorEnabled || isTelemetryPerformanceEnabled
    ? nconf.get('telemetry:sentry') ||
      'https://b5b0f0a0e44d42edb3d39e52fc6d78e1@o917768.ingest.sentry.io/5860254'
    : ''

// Init Sentry Server
if (sentryDsn) {
  Sentry.init({
    debug: !!nconf.get('telemetry:debug') || false,
    dsn: sentryDsn,
    release: 'hitokoto-api@v' + nconf.get('version'),
    tracesSampler(samplingContext) {
      return 0.0001 // default rate
    },
    attachStacktrace: true,
    integrations: function (integrations) {
      return integrations
        .filter((integration) => {
          // TODO: 也许未来可以在这里进行全局捕获？
          return integration.name !== 'OnUncaughtException' // 禁止默认的错误捕获行为
        })
        .concat([
          new Sentry.Integrations.LinkedErrors(),
          new DedupeIntegration(),
          new ExtraErrorDataIntegration(),
          new TransactionIntegration(),
        ])
    },
    serverName: nconf.get('api_name') || os.hostname(),
    environment: nconf.get('dev') ? 'development' : 'production',
  })
}

function CaptureUncaughtException(error) {
  // 遥测自身出错绝不能影响主流程，否则 uncaughtException 处理器会变成新的崩溃源
  try {
    if (!sentryDsn) return
    const hub = Sentry.getCurrentHub()
    hub.withScope((scope) => {
      // @sentry/node v7 起移除了 Sentry.Severity 枚举，改用等级字符串
      scope.setLevel('fatal')
      hub.captureException(error, {
        originalException: error,
        data: { mechanism: { handled: false, type: 'onUncaughtException' } },
      })
    })
  } catch (e) {
    // ignore
  }
}

module.exports = {
  Sentry,
  Tracing,
  CaptureUncaughtException,
}
