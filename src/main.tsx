import 'core-js/actual/array/at'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createDefaultOpenAIProfile, hasDefaultPresetConfig } from './lib/apiProfiles'
import { getCustomProviderConfigUrl, hasEmbeddedDefaultConfig, loadCustomProviderSettingsFromUrl, loadEmbeddedDefaultConfig } from './lib/customProviderConfigUrl'
import 'streamdown/styles.css'
import 'katex/dist/katex.min.css'
import './index.css'
import { installMobileViewportGuards } from './lib/viewport'
import { readRuntimeEnv } from './lib/runtimeEnv'
import { setPresetConfig, validatePresetOnlyConfig } from './lib/presetConfig'

installMobileViewportGuards()

if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((error) => {
        console.error('Service worker registration failed:', error)
      })
    })
  } else {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => registration.unregister())
    })
  }
}

const presetConfigOnlyRequested =
  readRuntimeEnv(import.meta.env.VITE_SHOW_PRESET_CONFIG_ONLY) === 'true' ||
  readRuntimeEnv(import.meta.env.VITE_SHOW_DEFAULT_CONFIG_ONLY) === 'true'

async function bootstrap() {
  try {
    const customProviderConfigUrl = getCustomProviderConfigUrl()
    const presetConfig = hasEmbeddedDefaultConfig()
      ? loadEmbeddedDefaultConfig()
      : customProviderConfigUrl
        ? loadCustomProviderSettingsFromUrl(customProviderConfigUrl)
        : hasDefaultPresetConfig()
          ? {
              customProviders: [],
              profiles: [{ ...createDefaultOpenAIProfile(), isDefault: true }],
            }
          : null

    if (presetConfigOnlyRequested) {
      const presetConfigError = validatePresetOnlyConfig(presetConfig)
      if (presetConfigError) throw new Error(presetConfigError)
    }

    setPresetConfig(presetConfig)
    if (presetConfigOnlyRequested && presetConfig) {
      const { useStore } = await import('./store')
      await useStore.getState().setPresetImportedSettings(presetConfig)
    }
  } catch (error) {
    if (presetConfigOnlyRequested) throw error
    console.warn('Failed to bootstrap preset config:', error)
    setPresetConfig(null)
  }

  const { default: App } = await import('./App')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void bootstrap().catch((error) => {
  console.error('Failed to bootstrap application:', error)
})
