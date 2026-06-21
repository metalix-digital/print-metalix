// On GCP, RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are fetched from Secret
// Manager at startup instead of living in a plaintext .env file. Local/dev
// runs without GCP credentials fall straight back to process.env, so nothing
// changes for development.
async function loadSecretsIntoEnv() {
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) return

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

    const [keyId, keySecret] = await Promise.all([
      fetchSecret('razorpay-key-id'),
      fetchSecret('razorpay-key-secret')
    ])
    process.env.RAZORPAY_KEY_ID = keyId
    process.env.RAZORPAY_KEY_SECRET = keySecret
    console.log('[secrets] loaded Razorpay keys from Secret Manager')
  } catch (err) {
    console.error('[secrets] could not load from Secret Manager, falling back to env:', err.message)
  }
}

module.exports = { loadSecretsIntoEnv }
