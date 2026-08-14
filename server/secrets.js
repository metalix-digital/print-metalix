// On GCP, RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are fetched from Secret
// Manager at startup instead of living in a plaintext .env file. Local/dev
// runs without GCP credentials fall straight back to process.env, so nothing
// changes for development.
async function loadSecretsIntoEnv() {
  const needed = [
    ['RAZORPAY_KEY_ID', 'razorpay-key-id'],
    ['RAZORPAY_KEY_SECRET', 'razorpay-key-secret'],
    ['ADMIN_PASSWORD', 'admin-password'],
    ['ADMIN_JWT_SECRET', 'admin-jwt-secret'],
    ['GOOGLE_CLIENT_ID', 'google-client-id'],
    ['GMAIL_USER', 'gmail-user'],
    ['GMAIL_APP_PASSWORD', 'gmail-app-password'],
    ['TWILIO_ACCOUNT_SID', 'twilio-account-sid'],
    ['TWILIO_AUTH_TOKEN', 'twilio-auth-token'],
    ['TWILIO_MESSAGING_SERVICE_SID', 'twilio-messaging-service-sid'],
    ['TWILIO_ORDER_CONFIRMATION_TEMPLATE_SID', 'twilio-order-confirmation-template-sid'],
    ['TWILIO_PAYMENT_LINK_TEMPLATE_SID', 'twilio-payment-link-template-sid']
  ].filter(([envVar]) => !process.env[envVar])

  if (!needed.length) return

  let SecretManagerServiceClient
  try {
    ;({ SecretManagerServiceClient } = require('@google-cloud/secret-manager'))
  } catch (err) {
    return
  }

  try {
    const client = new SecretManagerServiceClient()
    const project = await client.getProjectId()

    async function fetchSecret(name) {
      const [version] = await client.accessSecretVersion({
        name: `projects/${project}/secrets/${name}/versions/latest`
      })
      return version.payload.data.toString('utf8')
    }

    // Each secret is fetched independently — one that doesn't exist yet (e.g.
    // a feature whose secret hasn't been created in Secret Manager) must not
    // block every other secret from loading.
    const results = await Promise.allSettled(needed.map(([, secretName]) => fetchSecret(secretName)))
    const loaded = []
    const failed = []
    results.forEach((result, i) => {
      const [envVar] = needed[i]
      if (result.status === 'fulfilled') {
        process.env[envVar] = result.value
        loaded.push(envVar)
      } else {
        failed.push(envVar)
      }
    })
    if (loaded.length) console.log(`[secrets] loaded from Secret Manager: ${loaded.join(', ')}`)
    if (failed.length) console.warn(`[secrets] not set in Secret Manager (skipped): ${failed.join(', ')}`)
  } catch (err) {
    console.error('[secrets] could not reach Secret Manager, falling back to env:', err.message)
  }
}

module.exports = { loadSecretsIntoEnv }
