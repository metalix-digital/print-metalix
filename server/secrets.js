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
    ['GOOGLE_CLIENT_SECRET', 'google-client-secret'],
    ['GMAIL_USER', 'gmail-user'],
    ['GMAIL_APP_PASSWORD', 'gmail-app-password']
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

    const values = await Promise.all(needed.map(([, secretName]) => fetchSecret(secretName)))
    needed.forEach(([envVar], i) => { process.env[envVar] = values[i] })
    console.log(`[secrets] loaded from Secret Manager: ${needed.map(([envVar]) => envVar).join(', ')}`)
  } catch (err) {
    console.error('[secrets] could not load from Secret Manager, falling back to env:', err.message)
  }
}

module.exports = { loadSecretsIntoEnv }
