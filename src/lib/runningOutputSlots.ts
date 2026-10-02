export interface RunningOutputSlot {
  requestIndex: number
  outputImageIndex: number
  imageId: string
  error: string
}

export function buildStreamPreviewItems(
  requestedCount: number,
  slots: Record<string, string> | undefined,
  status: string | undefined,
): Array<{ key: string; src: string }> {
  const slotEntries = slots
    ? Object.entries(slots).filter(([, src]) => Boolean(src)).sort(([a], [b]) => Number(a) - Number(b))
    : []
  const count = Math.max(
    status === 'running' ? requestedCount : 0,
    slotEntries.length ? Math.max(...slotEntries.map(([key]) => Number(key) + 1)) : 0,
  )
  const byIndex = new Map(slotEntries.map(([key, src]) => [Number(key), src]))
  return Array.from({ length: count }, (_, index) => ({
    key: String(index),
    src: byIndex.get(index) ?? '',
  }))
}

export function buildRunningOutputSlots(input: {
  requestedCount: number
  outputImages?: string[]
  outputImageRequestIndexes?: number[]
  outputImageSubIndexes?: number[]
  outputErrors?: Array<{ requestIndex: number; error: string }>
}): RunningOutputSlot[] {
  const requestedCount = Math.max(1, input.requestedCount || 1)
  const images = input.outputImages ?? []
  const requestIndexes = input.outputImageRequestIndexes ?? images.map((_, index) => index)
  const subIndexes = input.outputImageSubIndexes ?? images.map(() => 0)
  const errors = new Map((input.outputErrors ?? []).map((item) => [item.requestIndex, item.error]))
  const grouped = new Map<number, Array<{ imageId: string; outputImageIndex: number; imageIndex: number }>>()

  images.forEach((imageId, outputImageIndex) => {
    const requestIndex = requestIndexes[outputImageIndex] ?? outputImageIndex
    const imageIndex = subIndexes[outputImageIndex] ?? 0
    const list = grouped.get(requestIndex) ?? []
    list.push({ imageId, outputImageIndex, imageIndex })
    grouped.set(requestIndex, list)
  })
  for (const list of grouped.values()) {
    list.sort((a, b) => a.imageIndex - b.imageIndex || a.outputImageIndex - b.outputImageIndex)
  }

  const slots: RunningOutputSlot[] = []
  for (let requestIndex = 0; requestIndex < requestedCount; requestIndex += 1) {
    const list = grouped.get(requestIndex) ?? []
    if (list.length > 0) {
      for (const item of list) {
        slots.push({
          requestIndex,
          outputImageIndex: item.outputImageIndex,
          imageId: item.imageId,
          error: '',
        })
      }
      continue
    }
    slots.push({
      requestIndex,
      outputImageIndex: -1,
      imageId: '',
      error: errors.get(requestIndex) ?? '',
    })
  }

  const extraRequestIndexes = [...grouped.keys()]
    .filter((requestIndex) => requestIndex < 0 || requestIndex >= requestedCount)
    .sort((a, b) => a - b)
  for (const requestIndex of extraRequestIndexes) {
    for (const item of grouped.get(requestIndex) ?? []) {
      slots.push({
        requestIndex,
        outputImageIndex: item.outputImageIndex,
        imageId: item.imageId,
        error: '',
      })
    }
  }
  return slots
}

export function findStreamPreviewSrc(
  items: Array<{ key: string; src: string }>,
  requestIndex: number,
): string {
  return items.find((item) => Number(item.key) === requestIndex)?.src ?? ''
}

export function buildVisibleOutputSlots(input: {
  status?: string
  requestedCount: number
  outputImages?: string[]
  outputImageRequestIndexes?: number[]
  outputImageSubIndexes?: number[]
  outputErrors?: Array<{ requestIndex: number; error: string }>
}): RunningOutputSlot[] {
  const outputImages = input.outputImages ?? []
  const outputErrors = input.outputErrors ?? []
  if (input.status === 'running') return buildRunningOutputSlots(input)

  const hasSlotIndexes = input.outputImageRequestIndexes?.length === outputImages.length && outputImages.length > 0
  if (hasSlotIndexes) {
    return buildRunningOutputSlots(input).filter((slot) => slot.imageId || slot.error)
  }

  if (outputErrors.length === 0) {
    return outputImages.map((imageId, outputImageIndex) => ({
      requestIndex: outputImageIndex,
      outputImageIndex,
      imageId,
      error: '',
    }))
  }

  const errorsByIndex = new Map(outputErrors.map((item) => [item.requestIndex, item.error]))
  const requestedCount = Math.max(input.requestedCount, outputImages.length + outputErrors.length)
  let outputImageIndex = 0
  return Array.from({ length: requestedCount }, (_, requestIndex) => {
    const error = errorsByIndex.get(requestIndex)
    if (error) return { requestIndex, outputImageIndex: -1, imageId: '', error }
    const imageId = outputImages[outputImageIndex] ?? ''
    const slot = { requestIndex, outputImageIndex, imageId, error: '' }
    outputImageIndex += 1
    return slot
  })
}

export function earliestOutputImageId(input: {
  outputImages?: string[]
  outputImageRequestIndexes?: number[]
  outputImageSubIndexes?: number[]
}): string | undefined {
  const images = input.outputImages ?? []
  if (!images.length) return undefined
  const requestIndexes = input.outputImageRequestIndexes
  if (!requestIndexes || requestIndexes.length !== images.length) return images[0]
  let best = 0
  for (let index = 1; index < images.length; index += 1) {
    const requestIndex = requestIndexes[index] ?? index
    const imageIndex = input.outputImageSubIndexes?.[index] ?? 0
    const bestRequestIndex = requestIndexes[best] ?? best
    const bestImageIndex = input.outputImageSubIndexes?.[best] ?? 0
    if (requestIndex < bestRequestIndex || (requestIndex === bestRequestIndex && imageIndex < bestImageIndex)) best = index
  }
  return images[best]
}
