const Sentry = require('@sentry/node')
const Tracing = require('@sentry/tracing')
const {
  Dedupe: DedupeIntegration,
  ExtraErrorData: ExtraErrorDataIntegration,
  Transaction: TransactionIntegration,
} = require('@sentry/integrations')
const nconf = require('nconf')
const os = require('os')
const isTelemetryErrorEnabled = nconf.get('telemetry:error')
const isTelemetryPerformanceEnabled = nconf.get('telemetry:performance')
// Init Sentry Server
Sentry.init({
  debug: !!nconf.get('telemetry:debug') || false,
  dsn:
    isTelemetryErrorEnabled && isTelemetryPerformanceEnabled
      ? nconf.get('telemetry:sentry') || 'https://b5b0f0a0e44d42edb3d39e52fc6d78e1@o917768.ingest.sentry.io/5860254'
      : false,
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

function CaptureUncaughtException(error) {
  const hub = Sentry.getCurrentHub()
  hub.withScope((scope) => {
    scope.setLevel(Sentry.Severity.Fatal)
    hub.captureException(error, {
      originalException: error,
      data: { mechanism: { handled: false, type: 'onUncaughtException' } },
    })
  })
}

module.exports = {
  Sentry,
  Tracing,
  CaptureUncaughtException,
}
