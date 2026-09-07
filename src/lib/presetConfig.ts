import type { ApiProfile, AppSettings, CustomProviderDefinition } from '../types'
import { readRuntimeEnv } from './runtimeEnv'

const RAW_SHOW_PRESET_CONFIG_ONLY = readRuntimeEnv(import.meta.env.VITE_SHOW_PRESET_CONFIG_ONLY)
const SHOW_PRESET_CONFIG_ONLY = (RAW_SHOW_PRESET_CONFIG_ONLY || readRuntimeEnv(import.meta.env.VITE_SHOW_DEFAULT_CONFIG_ONLY)) === 'true'
const LOCK_PRESET_CONFIG_PARAMS = readRuntimeEnv(import.meta.env.VITE_LOCK_PRESET_CONFIG_PARAMS) === 'true'
const PREVENT_PRESET_CONFIG_DELETION = readRuntimeEnv(import.meta.env.VITE_PREVENT_PRESET_CONFIG_DELETION) === 'true'

let presetProfiles: ApiProfile[] = []
let presetProviders: CustomProviderDefinition[] = []
let presetProfileFields: Record<string, string[]> | undefined
let defaultPresetProfileId: string | null = null

export function isRkSingleConfig(settings: Pick<AppSettings, 'customProviders' | 'profiles'> | null): boolean {
  return Boolean(
    settings &&
    settings.customProviders.length === 0 &&
    settings.profiles.length === 1 &&
    settings.profiles[0]?.provider === 'openai',
  )
}

export function setPresetConfig(settings: Pick<AppSettings, 'customProviders' | 'profiles'> & {
  presetProfileFields?: Record<string, string[]>
} | null) {
  if (SHOW_PRESET_CONFIG_ONLY) {
    const error = validatePresetOnlyConfig(settings)
    if (error) throw new Error(error)
  }
  presetProfiles = settings?.profiles.map((profile) => ({ ...profile })) ?? []
  presetProviders = settings?.customProviders.map((provider) => ({ ...provider })) ?? []
  presetProfileFields = settings?.presetProfileFields
  defaultPresetProfileId = presetProfiles.length === 1
    ? presetProfiles[0].id
    : presetProfiles.find((profile) => profile.isDefault === true)?.id ?? null
}

export function getPresetProfileIds() {
  return new Set(presetProfiles.map((profile) => profile.id))
}

export function getPresetProfileDescription(id: string) {
  return presetProfiles.find((profile) => profile.id === id)?.description
}

export function getPresetProviderIds() {
  return new Set(presetProviders.map((provider) => provider.id))
}

export function getPresetConfig() {
  if (presetProfiles.length === 0 && presetProviders.length === 0) return null
  return {
    customProviders: presetProviders.map((provider) => ({ ...provider })),
    profiles: presetProfiles.map((profile) => ({ ...profile })),
    presetProfileFields,
  }
}

export function getDefaultPresetProfileId() {
  return defaultPresetProfileId
}

export function getDefaultPresetBaseUrl() {
  const profile = presetProfiles.find((profile) => profile.id === defaultPresetProfileId)
  if (!profile || profile.provider === 'fal') return ''
  return profile.baseUrl
}

export function isPresetProfile(id: string) {
  return presetProfiles.some((profile) => profile.id === id)
}

export function isPresetProvider(id: string) {
  return presetProviders.some((provider) => provider.id === id)
}

export function isPresetConfigOnlyEnabled() {
  return presetProfiles.length > 0 && (
    SHOW_PRESET_CONFIG_ONLY ||
    isRkSingleConfig({ customProviders: presetProviders, profiles: presetProfiles })
  )
}

export function isPresetConfigParamsLocked() {
  // RK 单配置显式禁用模式只锁定配置身份和供应商管理，模型、API 接口等参数仍需可调。
  // 因此该模式优先于旧的全参数锁定开关，避免两套部署策略叠加后意外锁死模型。
  return LOCK_PRESET_CONFIG_PARAMS && !isPresetConfigOnlyEnabled() && presetProfiles.length > 0
}

export function isPresetConfigDeletionPrevented() {
  return (PREVENT_PRESET_CONFIG_DELETION || isPresetConfigOnlyEnabled()) && presetProfiles.length > 0
}

export function validatePresetOnlyConfig(settings: Pick<AppSettings, 'customProviders' | 'profiles'> | null): string | null {
  if (!settings) return 'RK API 单配置模式未加载到任何预置配置'
  if (!Array.isArray(settings.profiles) || settings.profiles.length !== 1) {
    return 'RK API 单配置模式仅支持一个预置配置'
  }
  if ((settings.customProviders?.length ?? 0) > 0) {
    return 'RK API 单配置模式不允许自定义服务商'
  }
  if (settings.profiles[0]?.provider !== 'openai') {
    return 'RK API 单配置模式仅支持 RK API 预置配置'
  }
  return null
}

export function isPresetProfileLocked(id: string) {
  return isPresetConfigParamsLocked() && isPresetProfile(id)
}

export function isPresetProviderLocked(id: string) {
  return isPresetConfigParamsLocked() && isPresetProvider(id)
}

export function isPresetProviderDeletionPrevented(id: string, profiles: ApiProfile[]) {
  if (!isPresetProvider(id)) return false
  if (isPresetConfigDeletionPrevented()) return true
  return profiles.some((profile) => profile.provider === id && isPresetProfileLocked(profile.id))
}

export function enforcePresetConfigPolicy(
  settings: AppSettings,
  options: { dismissedPresetProviderIds?: string[] } = {},
): AppSettings {
  const presetConfigOnly = isPresetConfigOnlyEnabled()
  const paramsLocked = isPresetConfigParamsLocked()
  if (presetProfiles.length === 0) return settings

  const dismissedProviderIds = new Set(options.dismissedPresetProviderIds ?? [])
  const profileIds = getPresetProfileIds()
  const presetProfilesById = new Map(presetProfiles.map((profile) => [profile.id, profile]))
  const presetProvidersById = new Map(presetProviders.map((provider) => [provider.id, provider]))
  const profiles = settings.profiles.map((profile) => {
    const preset = presetProfilesById.get(profile.id)
    if (!preset) return profile.isDefault ? { ...profile, isDefault: undefined } : profile
    const nextProfile = paramsLocked
      ? preset
      : presetConfigOnly
        ? {
            ...profile,
            name: preset.name,
            provider: preset.provider,
            baseUrl: preset.baseUrl,
          }
        : profile
    return {
      ...nextProfile,
      apiKey: profile.apiKey,
      isDefault: profile.id === defaultPresetProfileId ? true : undefined,
    }
  })
  if (isPresetConfigDeletionPrevented()) {
    for (const profile of presetProfiles) {
      if (!profiles.some((item) => item.id === profile.id)) profiles.push({ ...profile, isDefault: profile.id === defaultPresetProfileId ? true : undefined })
    }
  }
  const customProviders = settings.customProviders.filter((provider) => !dismissedProviderIds.has(provider.id)).map((provider) => {
    const preset = presetProvidersById.get(provider.id)
    return preset && paramsLocked ? preset : provider
  })
  for (const provider of presetProviders) {
    if (dismissedProviderIds.has(provider.id)) continue
    if (!customProviders.some((item) => item.id === provider.id)) customProviders.push(provider)
  }
  const activeProfileId = presetConfigOnly && !profileIds.has(settings.activeProfileId)
    ? defaultPresetProfileId ?? presetProfiles[0]?.id ?? settings.activeProfileId
    : settings.activeProfileId
  const agentTextProfileId = presetConfigOnly && (!settings.agentTextProfileId || !profileIds.has(settings.agentTextProfileId))
    ? presetProfiles.find((profile) => profile.provider === 'openai' && profile.apiMode === 'responses')?.id ?? null
    : settings.agentTextProfileId
  const agentImageProfileId = presetConfigOnly && (!settings.agentImageProfileId || !profileIds.has(settings.agentImageProfileId))
    ? defaultPresetProfileId ?? presetProfiles[0]?.id ?? null
    : settings.agentImageProfileId
  const nextProfiles = presetConfigOnly
    ? profiles.filter((profile) => profileIds.has(profile.id))
    : profiles
  const nextCustomProviders = presetConfigOnly
    ? []
    : customProviders

  return {
    ...settings,
    customProviders: nextCustomProviders,
    profiles: nextProfiles,
    activeProfileId,
    agentTextProfileId,
    agentImageProfileId,
  }
}
