import { BrowserWindow } from 'electron'
import { closeSync, openSync, rmSync, writeSync } from 'node:fs'

/**
 * Decodes a compressed recording (webm/opus or mp4/AAC from the phone) to 16 kHz mono Int16 PCM
 * with Chromium's own decoder, in a hidden page that has no Node, no preload and no network: no
 * ffmpeg needed, the same on macOS and Windows. decodeAudioData resamples to the context's
 * rate, so a 16 kHz OfflineAudioContext hands back 16 kHz samples directly.
 *
 * The samples are written straight to `outPath` (raw PCM, the meeting's .raw/mic.pcm format), a minute
 * at a time, so neither process holds a second full copy of a long recording. The page crashing (out of
 * memory on a very long file) or taking too long rejects instead of leaving the pull waiting forever.
 */
const IN_CHUNK = 3 * 1024 * 1024 // bytes of input per call into the page
const OUT_CHUNK = 16000 * 60 // samples (one minute) per call out of the page

/** How long a decode may take: 2 minutes, plus 20 s per MB of input (a 60 MB, 4-hour file: about 22 minutes). */
export function decodeTimeoutMs(inputBytes: number): number {
  return 120_000 + Math.ceil(inputBytes / 1_000_000) * 20_000
}

/** Decodes `bytes` and writes 16 kHz mono Int16 PCM to `outPath`; resolves with the number of samples. */
export async function decodeToPcmFile(bytes: Uint8Array, outPath: string, opts: { timeoutMs?: number } = {}): Promise<number> {
  const win = new BrowserWindow({
    show: false,
    width: 200,
    height: 200,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, images: false, spellcheck: false }
  })
  let timer: NodeJS.Timeout | undefined
  // Rejects when the page dies or time runs out; every step below races against it.
  const failure = new Promise<never>((_, reject) => {
    win.webContents.once('render-process-gone', (_e, d) => reject(new Error(`the decoder stopped (${d.reason})`)))
    timer = setTimeout(() => reject(new Error('decoding took too long')), opts.timeoutMs ?? decodeTimeoutMs(bytes.byteLength))
  })
  failure.catch(() => undefined)
  const step = <T>(p: Promise<T>): Promise<T> => Promise.race([p, failure])
  let fd: number | null = null
  try {
    // An empty page that runs only the code below; the app-wide handlers (index.ts) block navigation and new windows.
    await step(win.loadURL('about:blank'))
    const wc = win.webContents
    await step(wc.executeJavaScript('window.__klaraIn = []; 0'))
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let i = 0; i < buf.length; i += IN_CHUNK) {
      const b64 = buf.subarray(i, i + IN_CHUNK).toString('base64')
      await step(wc.executeJavaScript(`window.__klaraIn.push(${JSON.stringify(b64)}); 0`))
    }
    const decoded: number | string = await step(wc.executeJavaScript(`(async () => {
      const parts = window.__klaraIn.map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
      window.__klaraIn = null
      const total = parts.reduce((n, p) => n + p.length, 0)
      let all = new Uint8Array(total)
      let o = 0
      for (const p of parts) { all.set(p, o); o += p.length }
      parts.length = 0
      const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: 16000 })
      let audio
      try {
        audio = await ctx.decodeAudioData(all.buffer)
      } catch (e) {
        return 'undecodable: ' + String((e && e.message) || e) // errors don't cross executeJavaScript well
      }
      all = null
      window.__klaraAudio = audio // converted to Int16 a minute at a time, below
      return audio.length
    })()`))
    if (typeof decoded === 'string') throw new Error(`EncodingError ${decoded}`)
    const samples = decoded
    fd = openSync(outPath, 'w')
    for (let start = 0; start < samples; start += OUT_CHUNK) {
      const end = Math.min(samples, start + OUT_CHUNK)
      const b64: string = await step(wc.executeJavaScript(`(() => {
        const audio = window.__klaraAudio, start = ${start}, n = ${end - start}
        const channels = []
        for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c).subarray(start, start + n))
        const out = new Int16Array(n)
        for (let i = 0; i < n; i++) {
          let v = 0
          for (const ch of channels) v += ch[i]
          v /= channels.length || 1
          out[i] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767)
        }
        const b = new Uint8Array(out.buffer)
        let bin = ''
        for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000))
        return btoa(bin)
      })()`))
      const chunk = Buffer.from(b64, 'base64')
      if (chunk.length !== (end - start) * 2) throw new Error('the decoder returned a short block')
      writeSync(fd, chunk)
    }
    closeSync(fd)
    fd = null
    return samples
  } catch (err) {
    if (fd !== null) closeSync(fd)
    fd = null
    rmSync(outPath, { force: true })
    const msg = typeof err === 'object' && err && 'message' in err ? String((err as Error).message) : JSON.stringify(err)
    // decodeAudioData rejects with an EncodingError ("Unable to decode audio data") for a file it can't read.
    throw new Error(/EncodingError|Unable to decode audio/i.test(msg) ? 'the recording could not be decoded' : `decoding failed: ${msg.slice(0, 200)}`)
  } finally {
    clearTimeout(timer)
    if (!win.isDestroyed()) win.destroy()
  }
}
