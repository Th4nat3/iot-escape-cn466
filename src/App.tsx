import { predictIntent } from './miniAi'
import { useEffect, useRef, useState } from 'react'
import './App.css'
import './hardware-extra.css'

type Page = 'home' | 'missions' | 'codex'
type Feedback = { ok: boolean; text: string } | null

// A missing sensor is represented by JSON null, never by a made-up number.
type HardwareTelemetry = {
  temperature: number | null
  humidity: number | null
  soil_moisture: number | null
  plant_name: string
  data_origin?: string // Firmware-reported label; NOT proof of a physical sensor.
}
type WifiStatus = {
  connected: boolean
  state: string
  ip: string | null
  rssi_dbm: number | null
  timestamp: number
  mqtt_connected: boolean
}
type HttpCheck = {ok: boolean; ip: string | null; timestamp: number}

type HardwareMessage = {
  type: 'ESP32_TELEMETRY'
  source: 'ESP32-S2'
  timestamp: number
  payload: HardwareTelemetry
}
const HARDWARE_CHANNEL = 'iot-escape-hardware'
const HARDWARE_TIMEOUT_MS = 10000

function validHardwareMessage(value: unknown): value is HardwareMessage {
  if (!value || typeof value !== 'object') return false
  const msg = value as Record<string, unknown>
  if (msg.type !== 'ESP32_TELEMETRY' || msg.source !== 'ESP32-S2' ||
      typeof msg.timestamp !== 'number' || !Number.isFinite(msg.timestamp) ||
      msg.timestamp > Date.now() + 5000 || Date.now() - msg.timestamp > HARDWARE_TIMEOUT_MS ||
      !msg.payload || typeof msg.payload !== 'object' || Array.isArray(msg.payload)) return false
  const payload = msg.payload as Record<string, unknown>
  const numeric = ['temperature', 'humidity', 'soil_moisture']
  if (!numeric.every(k => Object.prototype.hasOwnProperty.call(payload, k) &&
      (payload[k] === null || (typeof payload[k] === 'number' && Number.isFinite(payload[k]))))) return false
  if (typeof payload.plant_name !== 'string' || !payload.plant_name.trim()) return false
  if (payload.data_origin !== undefined && typeof payload.data_origin !== 'string') return false
  return true
}

function telemetryRangesValid(payload: HardwareTelemetry): boolean {
  const inRange = (value: number | null, min: number, max: number) =>
    value === null || (value >= min && value <= max)
  return inRange(payload.temperature, -40, 125) &&
    inRange(payload.humidity, 0, 100) &&
    inRange(payload.soil_moisture, 0, 65535)
}


type Answers = {
  pipeline: string[]
  statusPin: string
  rgbPin: string
  bootPin: string
  httpMethod: string
  endpoint: string
  telemetry: string
  aiInstruction: string
  expectedIntent: string
  red: string
  green: string
  blue: string
  accessCode: string
  sequence: string[]
}

const STORAGE_KEY = 'iot-escape-progress-v1'
const missions = [
  { id: 1, code: 'M01', title: 'SYSTEM AWAKENING', thai: 'ปลุกระบบ AIoT', topic: 'IoT architecture', points: 10, intro: 'จัดเรียงเส้นทางข้อมูลจากอุปกรณ์ Edge ไปถึงผู้ใช้งานให้ถูกต้อง' },
  { id: 2, code: 'M02', title: 'HARDWARE DISCOVERY', thai: 'ถอดรหัสบอร์ด', topic: 'ESP32-S2 & GPIO', points: 15, intro: 'อ่านแผนผัง Cucumber R และจับคู่ขาที่ทำหน้าที่สำคัญ' },
  { id: 3, code: 'M03', title: 'BROKEN CONNECTION', thai: 'ซ่อมการสื่อสาร', topic: 'HTTP & JSON', points: 15, intro: 'สร้างคำขอ HTTP และข้อมูล Telemetry ที่ตรวจสอบรูปแบบได้' },
  { id: 4, code: 'M04', title: 'TALK TO THE AI', thai: 'สื่อสารกับ AI', topic: 'Natural language → JSON', points: 20, intro: 'แปลงคำสั่งภาษามนุษย์เป็นคำสั่งอุปกรณ์อย่างมีโครงสร้าง' },
  { id: 5, code: 'M05', title: 'THE RGB CIPHER', thai: 'รหัสแสง RGB', topic: 'WS2812 & color data', points: 20, intro: 'คำนวณค่าสี 8 บิตของแต่ละช่อง และจำลองการควบคุม RGB LED' },
  { id: 6, code: 'M06', title: 'THE FINAL ESCAPE', thai: 'ปลดล็อกห้องทดลอง', topic: 'Closed-loop verification', points: 20, intro: 'รวม Telemetry, ลำดับคำสั่ง และการตรวจสอบผลกลับจากอุปกรณ์จำลอง' },
] as const

const components = ['USER INTERFACE', 'EDGE NODE', 'AI ENGINE', 'GATEWAY']
const correctPipeline = ['EDGE NODE', 'GATEWAY', 'AI ENGINE', 'USER INTERFACE']
const initialAnswers: Answers = {
  pipeline: [], statusPin: '', rgbPin: '', bootPin: '', httpMethod: 'GET', endpoint: '',
  telemetry: '{"device":"cucumber-r","uptime_s":120,"rssi_dbm":-55}',
  aiInstruction: '', expectedIntent: '', red: '0', green: '0', blue: '0', accessCode: '', sequence: [],
}

function readProgress(): number[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(value)) return []
    const saved = new Set(value.filter((id): id is number => Number.isInteger(id) && id >= 1 && id <= 6))
    // Only accept a contiguous prefix. Corrupted/legacy storage must not unlock later missions.
    const verified: number[] = []
    for (let id = 1; id <= 6 && saved.has(id); id++) verified.push(id)
    return verified
  } catch {
    // localStorage may be blocked (private browsing or browser policy).
    return []
  }
}

function interpretCommand(text: string): { intent: string; r: number; g: number; b: number } | null {
  const normalized = text.toLowerCase().trim()
  // A negated command must never be interpreted as a request to turn the LED on.
  const isNegated = /\b(?:don't|dont|never|no|not|off)\b|\bdo\s+not\b|\bturn\s+off\b|อย่า|ห้าม|ไม่ต้อง|ไม่(?=อยาก|เอา|ให้|เปิด|เปลี่ยน|ตั้ง)|ยกเลิก|ปิดไฟ|ดับไฟ/.test(normalized)
  const wantsBlue = /blue|สีน้ำเงิน|สีฟ้า/.test(normalized)
  const wantsLight = /led|ไฟ|light|rgb|เปลี่ยนสี|ตั้งสี|เปิด/.test(normalized)
  if (!isNegated && wantsBlue && wantsLight) return { intent: 'SET_RGB', r: 0, g: 0, b: 255 }
  return null
}

function App() {
  const [page, setPage] = useState<Page>('home')
  const [active, setActive] = useState(1)
  const [finished, setFinished] = useState<number[]>(readProgress)
  const [answers, setAnswers] = useState<Answers>(initialAnswers)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [hardware, setHardware] = useState<HardwareMessage | null>(null)
  const [hardwareNow, setHardwareNow] = useState(() => Date.now())
  const [hardwareCheck, setHardwareCheck] = useState<Feedback>(null)
  const [packetCount, setPacketCount] = useState(0)
  const [wifiStatus, setWifiStatus] = useState<WifiStatus | null>(null)
  const [httpStatus, setHttpStatus] = useState<HttpCheck | null>(null)
  const pendingRequestId = useRef<string | null>(null)
  const [pingState, setPingState] = useState<'idle'|'waiting'|'pass'|'fail'>('idle')
  const [pingInfo, setPingInfo] = useState('ยังไม่ได้ทดสอบ PING จากเกม')
  // Hardware checkpoints are intentionally session-only and separate from training scores.
  const [hardwareEvidence, setHardwareEvidence] = useState<Record<number, number>>({})
  const [hardwareMissionFeedback, setHardwareMissionFeedback] = useState<Feedback>(null)
  const hardwareLive = hardware !== null && hardwareNow - hardware.timestamp <= HARDWARE_TIMEOUT_MS
  const wifiLive = hardwareLive && wifiStatus?.connected === true && hardwareNow - wifiStatus.timestamp <= 15000
  const httpLive = wifiLive && httpStatus?.ok === true && httpStatus.ip === wifiStatus?.ip && hardwareNow - httpStatus.timestamp <= 60000
  const dataOrigin = hardware?.payload.data_origin ?? 'UNSPECIFIED'
  const noSensor = hardware?.payload.temperature === null &&
    hardware?.payload.humidity === null && hardware?.payload.soil_moisture === null
  const boardStatusLabel = !hardwareLive ? '○ WAITING FOR HARDWARE' :
    (dataOrigin === 'NO_SENSOR' || noSensor) ? '● BOARD CONNECTED / NO SENSOR' :
    dataOrigin === 'SIMULATED' ? '● BOARD CONNECTED / SIMULATED DATA' :
    '● BOARD CONNECTED / TELEMETRY'

  const current = missions[active - 1]
  const points = missions.filter(m => finished.includes(m.id)).reduce((sum, m) => sum + m.points, 0)
  const completion = Math.round((finished.length / missions.length) * 100)
  const aiResult = interpretCommand(answers.aiInstruction)
  const localMlResult = predictIntent(answers.aiInstruction)
  const allComplete = finished.length === 6
  const colorIsValid = [answers.red, answers.green, answers.blue].every(n => /^(\d{1,3})$/.test(n) && Number(n) <= 255)
  const ledPreview = colorIsValid ? `rgb(${answers.red},${answers.green},${answers.blue})` : 'rgb(12,21,40)'

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(finished))
    } catch {
      // The game remains usable in memory if the browser disables storage.
    }
  }, [finished])

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    const channel = new BroadcastChannel(HARDWARE_CHANNEL)
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data
      if (validHardwareMessage(message)) {
        setHardware(message)
        setHardwareNow(Date.now())
        setPacketCount(n => n + 1)
      } else if (message && typeof message === 'object') {
        const link = message as Record<string, unknown>
        if (link.type === 'ESP32_WIFI_STATUS' && link.source === 'ESP32-S2' &&
            typeof link.timestamp === 'number' && Number.isFinite(link.timestamp) &&
            Math.abs(Date.now() - link.timestamp) <= 5000 && link.payload &&
            typeof link.payload === 'object' && !Array.isArray(link.payload)) {
          const wifi = link.payload as Record<string, unknown>
          if (typeof wifi.connected === 'boolean' && typeof wifi.state === 'string' &&
              (wifi.ip === null || (typeof wifi.ip === 'string' && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(wifi.ip) &&
                wifi.ip.split('.').every(n => Number(n) <= 255))) &&
              (wifi.rssi_dbm === null || (typeof wifi.rssi_dbm === 'number' && Number.isFinite(wifi.rssi_dbm)))) {
            setWifiStatus({connected:wifi.connected, state:wifi.state, ip:wifi.ip as string | null,
              rssi_dbm:wifi.rssi_dbm as number | null, timestamp:link.timestamp,
              mqtt_connected:wifi.mqtt_connected === true})
            if (!wifi.connected) setHttpStatus(null)
          }
        }
        if (link.type === 'ESP32_HTTP_STATUS' && link.source === 'ESP32-S2' &&
            typeof link.timestamp === 'number' && Number.isFinite(link.timestamp) &&
            Math.abs(Date.now() - link.timestamp) <= 5000 && typeof link.ok === 'boolean' &&
            (link.ip === null || typeof link.ip === 'string')) {
          setHttpStatus({ok:link.ok, ip:link.ip as string | null, timestamp:link.timestamp})
        }
        // Both request ID and the actual serial ACK must match. Telemetry is NOT an ACK.
        if ((link.type === 'ESP32_COMMAND_RESULT' || link.type === 'ESP32_ACK') &&
            link.source === 'ESP32-S2' &&
            typeof link.timestamp === 'number' && Number.isFinite(link.timestamp) &&
            Math.abs(Date.now() - link.timestamp) <= 10000) {
          const rawAck = link.type === 'ESP32_ACK' ? link.payload : link.ack
          const ack = rawAck && typeof rawAck === 'object' ? rawAck as Record<string, unknown> : null
          const requestId = typeof link.requestId === 'string' ? link.requestId :
            typeof link.id === 'string' ? link.id : ack?.id
          if (typeof requestId === 'string' && requestId === pendingRequestId.current &&
              (link.cmd === undefined || link.cmd === 'PING')) {
            pendingRequestId.current = null
            const verified = ack?.type === 'ACK' && ack.id === requestId &&
              ack.cmd === 'PING' && ack.ok === true && link.ok !== false
            setPingState(verified ? 'pass' : 'fail')
            setPingInfo(verified
              ? 'ACK RECEIVED — บอร์ดตอบ PING ผ่าน Serial จริง (ยังไม่ทดสอบ GPIO)'
              : 'PING FAILED — ' + String(link.error ?? 'ACK ไม่ตรงกับคำสั่งหรือบอร์ดปฏิเสธ'))
          }
        }
        // A disconnect event clears the display immediately; timeout is the fallback.
        if (link.type === 'ESP32_LINK_STATUS' && link.source === 'ESP32-S2' &&
            link.connected === false && typeof link.timestamp === 'number' &&
            Number.isFinite(link.timestamp) && Math.abs(Date.now() - link.timestamp) <= 5000) {
          if (pendingRequestId.current) {
            pendingRequestId.current = null
            setPingState('fail')
            setPingInfo('การเชื่อมต่อ ESP32-S2 ถูกตัดระหว่างทดสอบ PING')
          }
          setHardware(null)
          setHardwareCheck(null)
          setHardwareMissionFeedback(null)
          setPacketCount(0)
          setWifiStatus(null)
          setHttpStatus(null)
        }
      }
    }
    const timer = window.setInterval(() => setHardwareNow(Date.now()), 1000)
    return () => {
      channel.close()
      window.clearInterval(timer)
    }
  }, [])

  function sendGamePing() {
    if (!hardwareLive || typeof BroadcastChannel === 'undefined') {
      setPingState('fail'); setPingInfo('กรุณาเชื่อม Hardware Monitor และรอ Telemetry ก่อน'); return
    }
    const requestId = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
    pendingRequestId.current = requestId
    setPingState('waiting'); setPingInfo('กำลังรอ ACK จาก ESP32-S2 ...')
    const channel = new BroadcastChannel(HARDWARE_CHANNEL)
    channel.postMessage({
      type: 'ESP32_COMMAND',
      source: 'IOT_ESCAPE_GAME',
      cmd: 'PING', id: requestId, requestId,
      timestamp: Date.now(),
    })
    channel.close()
    window.setTimeout(() => {
      if (pendingRequestId.current === requestId) {
        pendingRequestId.current = null
        setPingState('fail'); setPingInfo('หมดเวลารอ ACK — ตรวจ Hardware Monitor และ Serial')
      }
    },6500)
  }
  function verifyLiveHardware() {
    if (!hardwareLive || !hardware) {
      setHardwareCheck({ ok: false, text: 'ยังไม่มี Telemetry ใหม่ภายใน 10 วินาที กรุณาเชื่อมต่อ Hardware Monitor' })
      return
    }
    if (!telemetryRangesValid(hardware.payload)) {
      setHardwareCheck({ ok: false, text: 'รับ JSON แล้ว แต่ค่าตัวเลขบางช่องอยู่นอกช่วงตรวจสอบเบื้องต้น กรุณาตรวจสอบ Firmware' })
      return
    }
    const origin = hardware.payload.data_origin ?? 'UNSPECIFIED'
    const noMeasurements = hardware.payload.temperature === null &&
      hardware.payload.humidity === null && hardware.payload.soil_moisture === null
    setHardwareCheck({
      ok: true,
      text: origin === 'NO_SENSOR' || noMeasurements
        ? 'BOARD STREAM VERIFIED — รับ JSON จากพอร์ต Serial ได้แล้ว แต่ยังไม่มีข้อมูลเซนเซอร์ (null) ไม่เพิ่มคะแนนเกม'
        : origin === 'SIMULATED'
          ? 'BOARD STREAM VERIFIED — รับ JSON ได้แล้ว แต่ Firmware ระบุว่าเป็นข้อมูลจำลอง ไม่ใช่ค่าจากเซนเซอร์จริง'
          : 'BOARD STREAM VERIFIED — รูปแบบ JSON และช่วงค่าผ่านการตรวจเบื้องต้น แต่ยังไม่ยืนยันความถูกต้องของเซนเซอร์',
    })
  }

  function verifyMissionHardware() {
    if (active > 3) return
    if (!hardwareLive || !hardware) {
      setHardwareMissionFeedback({ ok: false, text: 'ยังไม่มี Telemetry สด กรุณาเชื่อม ESP32-S2 ผ่าน Hardware Monitor แล้วเปิดทั้งสองแท็บไว้' })
      return
    }
    if (packetCount < 2) {
      setHardwareMissionFeedback({ ok: false, text: 'รอรับข้อมูลจากบอร์ดอย่างน้อย 2 ข้อความก่อนตรวจ เพื่อยืนยันการสื่อสารต่อเนื่อง' })
      return
    }
    // null is a valid "sensor not installed" value. It must not block transport evidence.
    if (!telemetryRangesValid(hardware.payload)) {
      setHardwareMissionFeedback({ ok: false, text: 'ค่าตัวเลขจาก Firmware บางช่องอยู่นอกช่วงตรวจสอบเบื้องต้น' })
      return
    }
    setHardwareEvidence(previous => ({ ...previous, [active]: Date.now() }))
    const result = active === 1
      ? 'รับข้อความจาก ESP32-S2 ต่อเนื่องแล้ว ≥ 2 ครั้ง (ยืนยันเส้นทางรับข้อมูลเท่านั้น)'
      : active === 2
        ? 'ตรวจพบข้อมูลที่ส่งมาจากบอร์ดแล้ว (ไม่ได้พิสูจน์ GPIO หรือวงจร LED)'
        : 'อ่าน JSON Telemetry จากพอร์ต Serial ได้ รวมถึงค่า null เมื่อไม่มีเซนเซอร์ (ไม่ใช่การทดสอบ HTTP /status)'
    setHardwareMissionFeedback({ ok: true, text: `HARDWARE EVIDENCE RECORDED — ${result} ไม่เพิ่มคะแนนเกม` })
  }

  function patch<K extends keyof Answers>(key: K, value: Answers[K]) {
    setAnswers(previous => ({ ...previous, [key]: value }))
    setFeedback(null)
  }

  function openMission(id: number) {
    if (id > 1 && !finished.includes(id - 1) && !finished.includes(id)) return
    setActive(id)
    setFeedback(null)
    setPage('missions')
    setHardwareMissionFeedback(null)
  }

  function checkMission() {
    // Validate prerequisites at the scoring boundary as well as in the UI.
    if (active < 1 || active > 6 ||
        Array.from({length: active - 1}, (_, index) => index + 1).some(id => !finished.includes(id))) {
      setFeedback({ ok: false, text: 'ต้องผ่านภารกิจตามลำดับ M01 → M06 ก่อนตรวจคำตอบ' })
      return
    }
    let success = false
    let error = ''
    if (active === 1) {
      success = answers.pipeline.join('|') === correctPipeline.join('|')
      error = 'ลำดับยังไม่ถูก: เริ่มจาก Edge Node → Gateway → AI Engine → User Interface'
    }
    if (active === 2) {
      success = answers.statusPin === 'GPIO2' && answers.rgbPin === 'GPIO18' && answers.bootPin === 'GPIO0'
      error = 'ตรวจสอบ Pinout: Status LED, RGB WS2812 และปุ่ม BOOT ต้องจับคู่ให้ครบ'
    }
    if (active === 3) {
      try {
        const data: unknown = JSON.parse(answers.telemetry)
        const object = data !== null && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {}
        success = answers.httpMethod === 'GET' && answers.endpoint.trim() === '/status' &&
          object.device === 'cucumber-r' && typeof object.uptime_s === 'number' &&
          Number.isFinite(object.uptime_s) && object.uptime_s >= 0 &&
          typeof object.rssi_dbm === 'number' && Number.isFinite(object.rssi_dbm) && object.rssi_dbm < 0
        error = 'ใช้ GET /status และ JSON ที่มี device="cucumber-r", uptime_s ≥ 0, rssi_dbm < 0'
      } catch {
        error = 'JSON ยังไม่ถูกต้อง: ตรวจสอบเครื่องหมายปีกกา จุลภาค และเครื่องหมายคำพูด'
      }
    }
    if (active === 4) {
      success = aiResult?.intent === 'SET_RGB' && answers.expectedIntent === 'SET_RGB'
      error = 'ลองพิมพ์ “เปลี่ยนไฟเป็นสีน้ำเงิน” แล้วเลือก SET_RGB เป็น Intent ที่ถูกต้อง'
    }
    if (active === 5) {
      success = colorIsValid && Number(answers.red) === 0 && Number(answers.green) === 180 && Number(answers.blue) === 255
      error = 'คำนวณอีกครั้ง: R = 0, G = 2 × 90 และ B = 255 (ช่วงค่า 0–255)'
    }
    if (active === 6) {
      const required = [1, 2, 3, 4, 5].every(id => finished.includes(id))
      success = required && answers.accessCode.trim() === '175' && answers.sequence.join('|') === 'BLUE|GREEN|RED'
      error = 'เงื่อนไขปลดล็อก: ผ่าน M01–M05, Token = |−55| + 120 = 175 และลำดับ BLUE → GREEN → RED'
    }
    if (success) {
      setFinished(previous => previous.includes(active) ? previous : [...previous, active].sort((a, b) => a - b))
      setFeedback({ ok: true, text: active === 6 ? 'ACCESS GRANTED — ปลดล็อกห้องทดลองสำเร็จ! (Simulation)' : 'VERIFIED — ตรวจคำตอบผ่านด้วยกฎที่กำหนดไว้' })
    } else {
      setFeedback({ ok: false, text: error })
    }
  }

  function resetProgress() {
    if (!window.confirm('เริ่มเกมใหม่? คะแนนและความคืบหน้าที่บันทึกในเบราว์เซอร์นี้จะถูกลบ')) return
    setFinished([])
    setAnswers(initialAnswers)
    setFeedback(null)
    setHardwareEvidence({})
    setHardwareMissionFeedback(null)
    setActive(1)
    setPage('home')
  }

  return (
    <div className="app-shell">
      <div className="noise-layer" aria-hidden="true" />
      <header className="header wrap">
        <button className="brand" type="button" onClick={() => setPage('home')} aria-label="กลับหน้าแรก">
          <span className="brand-icon">I<span>O</span>T</span>
          <span className="brand-text">ESCAPE <small>THE LOST PROTOCOL</small></span>
        </button>
        <nav className="header-nav" aria-label="เมนูหลัก">
          <button className={page === 'home' ? 'nav-active' : ''} onClick={() => setPage('home')}>OVERVIEW</button>
          <button className={page === 'missions' ? 'nav-active' : ''} onClick={() => setPage('missions')}>MISSIONS</button>
          <button className={page === 'codex' ? 'nav-active' : ''} onClick={() => setPage('codex')}>CODEX</button>
        </nav>
        <div className="mode-pill"><span className="signal-dot" /> {hardwareLive ? 'HARDWARE LIVE / PING ONLY' : 'SIMULATION MODE'}</div>
      </header>

      <main className="wrap main-content">
        {page === 'home' && (
          <>
            <section className="hero-grid">
              <div className="hero-copy">
                <div className="eyebrow"><span className="line" /> CN466 / AIoT LEARNING EXPERIENCE</div>
                <p className="kicker">LABORATORY BREACH DETECTED // 06 SECURITY LOCKS ACTIVE</p>
                <h1>LEARN THE SYSTEM.<br /><em>BREAK THE CODE.</em></h1>
                <p className="hero-description">ปฏิบัติภารกิจในห้องทดลอง AIoT จำลอง เรียนรู้การไหลของข้อมูล ESP32-S2, HTTP/JSON, AI Command และ RGB LED ผ่านปริศนาที่ตรวจคำตอบได้จริง</p>
                <div className="hero-actions">
                  <button className="action-primary" type="button" onClick={() => openMission(finished.length === 6 ? 6 : Math.min(6, finished.length + 1))}>
                    {finished.length ? 'CONTINUE MISSION' : 'INITIALIZE MISSION'} <span>↗</span>
                  </button>
                  <button className="action-outline" type="button" onClick={() => setPage('codex')}>VIEW LEARNING CODEX</button>
                </div>
                <div className="simulation-note"><span>◈</span> {hardwareLive ? 'กำลังรับ Telemetry ผ่าน USB; เกมและคะแนนยังเป็น Simulation ส่วน PING/Wi-Fi ทดสอบแยกโดยไม่สั่ง GPIO' : 'เกมนี้ใช้ข้อมูลจำลองเพื่อการเรียนรู้ ยังไม่ส่งคำสั่งถึงบอร์ดจริงหรือ LLM'}</div>
              </div>
              <div className="reactor-panel" aria-label="ภาพกราฟิกแสดงการจำลองระบบ AIoT">
                <div className="reactor-top"><span>REMOTE LAB / NODE-01</span><span>● SYSTEM STANDBY</span></div>
                <div className="rings"><div className="ring ring-one" /><div className="ring ring-two" /><div className="ring ring-three" /><div className="center-module"><span>ESP32-S2</span><strong>AIoT</strong><small>SIMULATED NODE</small></div></div>
                <div className="reactor-bottom"><span>EDGE NODE <b>READY</b></span><span>AI CORE <b>SIMULATED</b></span><span>SECURITY <b>06 LOCKS</b></span></div>
              </div>
            </section>
            <section className="briefing-card" aria-label="ESP32-S2 Live Telemetry" style={{ marginBottom: 24 }}>
              <div className="section-micro">ESP32-S2 / REAL HARDWARE / PING + WI-FI STATUS</div>
              <h2>{boardStatusLabel}</h2>
              <p>{hardwareLive ? 'รับข้อมูลที่ Firmware ส่งผ่าน USB Serial และ Hardware Monitor ได้แล้ว (ยังไม่ยืนยันว่ามีเซนเซอร์จริง)' : 'เปิด Hardware Monitor ในอีกแท็บของเบราว์เซอร์เดียวกัน แล้วเชื่อมต่อ ESP32-S2 เพื่อรับข้อมูลใหม่'}</p>
              {hardwareLive && <p className="help-text">DATA ORIGIN (FIRMWARE-REPORTED): {dataOrigin} · ค่า null หมายถึงไม่มีค่าที่วัดได้ ไม่ใช่เลขศูนย์</p>}
              <div className="fields-grid" style={{ marginTop: 16 }}>
                <div><small>TEMPERATURE</small><p>{hardwareLive ? (hardware?.payload.temperature ?? '—') : '—'} °C</p></div>
                <div><small>HUMIDITY (REPORTED)</small><p>{hardwareLive ? (hardware?.payload.humidity ?? '—') : '—'} %</p></div>
                <div><small>SOIL MOISTURE (RAW)</small><p>{hardwareLive ? (hardware?.payload.soil_moisture ?? '—') : '—'}</p></div>
                <div><small>PLANT NAME</small><p>{hardwareLive ? (hardware?.payload.plant_name ?? '—') : '—'}</p></div>
              </div>
              <p className="help-text">{hardwareLive && hardware ? `Last telemetry: ${new Date(hardware.timestamp).toLocaleTimeString('th-TH')}` : 'No fresh telemetry'} · Hardware values are not used to award mission points.</p>
              <div className="wifi-summary" role="group" aria-label="Wi-Fi and HTTP connection status">
                <span>PHONE HOTSPOT: <strong>{wifiLive ? `CONNECTED (${wifiStatus?.ip})` : wifiStatus?.state === 'CONNECTING' ? 'CONNECTING...' : 'NOT VERIFIED'}</strong></span>
                <span>HTTP /status: <strong>{httpLive ? 'VERIFIED' : 'NOT VERIFIED'}</strong></span>
                <span>MQTT: <strong>NOT CONFIGURED</strong></span>
              </div>
              <p className="help-text">ตั้งค่า Hotspot จาก Hardware Monitor · ถ้าคอมไม่ได้อยู่ Hotspot เดียวกับบอร์ด ให้ทดสอบ HTTP /status จาก Safari บน iPhone และเก็บภาพเป็นหลักฐานแยก (สถานะ HTTP ในเกมตรวจเฉพาะคำขอจากเบราว์เซอร์คอม) · ผล USB PING ไม่ใช่ผล Wi-Fi/MQTT · คะแนน M01–M06 เป็น Simulation</p>
              <div style={{ marginTop: 16, marginBottom: 12 }}>
                <button className="action-outline" type="button" onClick={verifyLiveHardware}>VERIFY BOARD TELEMETRY ↗</button>
                <button className="action-outline" type="button" disabled={!hardwareLive || pingState === 'waiting'} onClick={sendGamePing}>SEND REAL PING →</button>
                <p role="status" className="help-text">PING STATUS: {pingState.toUpperCase()} — {pingInfo}</p>
                {hardwareCheck && (!hardwareCheck.ok || hardwareLive) && <div className={`feedback ${hardwareCheck.ok ? 'success' : 'fail'}`} role="status" style={{ marginTop: 12 }}><strong>{hardwareCheck.ok ? '✓ BOARD STREAM CHECK PASS' : '! BOARD STREAM CHECK FAILED'}</strong><p>{hardwareCheck.text}</p></div>}
                <p className="help-text">ตรวจความครบถ้วนและช่วงค่าข้อมูลเบื้องต้นเท่านั้น ไม่ยืนยันความแม่นยำของเซนเซอร์ การตรวจ Telemetry ไม่ส่งคำสั่งไปยังบอร์ด ส่วนปุ่ม PING เป็นการทดสอบแยกต่างหาก และไม่เปลี่ยนคะแนนภารกิจ</p>
                <p className="hardware-truth-note"><strong>ข้อมูลจาก Firmware ≠ การยืนยันเซนเซอร์จริง:</strong> ภาพบอร์ดขณะนี้ยังไม่พบเซนเซอร์ภายนอก ค่าที่แสดงอาจถูกสร้างจากโปรแกรมบนบอร์ด แม้จะส่งผ่าน USB Serial จริงก็ตาม</p>
                <p className="help-text">Hardware checkpoints ในภารกิจ M01–M03 ที่บันทึกไว้ในหน้านี้: {Object.keys(hardwareEvidence).length}/3 (ไม่คิดคะแนนเพิ่ม)</p>
              </div>
              <a href={`${import.meta.env.BASE_URL}hardware-live.html`} target="_blank" rel="noopener noreferrer">OPEN HARDWARE MONITOR ↗</a>
            </section>
            <section className="stats-strip" aria-label="ความคืบหน้า">
              <div><small>SECURITY CLEARANCE</small><strong>{completion}<span>%</span></strong></div>
              <div><small>MISSIONS VERIFIED</small><strong>{String(finished.length).padStart(2, '0')}<span> / 06</span></strong></div>
              <div><small>OPERATOR SCORE</small><strong>{points}<span> / 100</span></strong></div>
              <div className="strip-message"><span>TRANSMISSION</span><p>{allComplete ? 'ALL MISSIONS COMPLETE // ACCESS GRANTED' : 'YOUR TRAINING SIMULATION IS READY'}</p></div>
            </section>
            <div className="section-heading"><div><span className="eyebrow">MISSION MAP</span><h2>Six locks. One way out.</h2></div><button className="text-link" onClick={() => setPage('missions')}>OPEN MISSION CONTROL →</button></div>
            <div className="mission-grid">
              {missions.map(m => {
                const locked = m.id > 1 && !finished.includes(m.id - 1) && !finished.includes(m.id)
                return <button className={`mission-card ${locked ? 'locked' : ''}`} key={m.id} disabled={locked} onClick={() => openMission(m.id)}>
                  <span className="card-top"><span className="code-label">{m.code} / {m.points} PTS</span><span>{finished.includes(m.id) ? '✓ VERIFIED' : locked ? 'LOCKED' : 'AVAILABLE'}</span></span>
                  <span className="mission-serial">0{m.id}</span><strong>{m.title}</strong><span className="card-thai">{m.thai}</span><span className="card-topic">{m.topic}</span>
                  <span className="card-arrow">{locked ? '◇' : '↗'}</span>
                </button>
              })}
            </div>
          </>
        )}

        {page === 'missions' && (
          <>
            <div className="mission-header"><div><div className="eyebrow">MISSION CONTROL / TRAINING SYSTEM</div><h1>MISSION <span>{String(active).padStart(2, '0')}</span></h1><p>คะแนนภารกิจยังเป็น Simulation ส่วน M01–M03 เพิ่มการตรวจหลักฐานจากบอร์ดจริงแยกต่างหาก (Read-only)</p></div><div className="mission-progress"><span>{finished.length}/6 COMPLETE</span><div className="progress-track"><div style={{ width: `${completion}%` }} /></div><strong>{points} PTS</strong></div></div>
            <div className="workspace-grid">
              <aside className="side-missions"><div className="aside-title">ACTIVE PROTOCOLS</div>{missions.map(m => {
                const locked = m.id > 1 && !finished.includes(m.id - 1) && !finished.includes(m.id)
                return <button className={active === m.id ? 'selected' : ''} key={m.id} disabled={locked} onClick={() => openMission(m.id)}>
                  <span>{m.code}</span><span className="side-name">{m.title}<small>{m.thai}</small></span><span>{finished.includes(m.id) ? '✓' : locked ? '⌑' : '›'}</span>
                </button>
              })}<button className="codex-shortcut" onClick={() => setPage('codex')}>↗ OPEN ENGINEERING CODEX</button></aside>
              <div className="work-main">
                <section className="briefing-card"><div className="section-micro">01 / CODEX BRIEFING</div><div className="briefing-title"><div><h2>{current.title}</h2><p>{current.intro}</p></div><span>{current.points} PTS</span></div><div className="lesson-topic">TOPIC: {current.topic}</div></section>
                {active <= 3 && (
                  <section className="briefing-card mission-hardware-checkpoint" aria-label="หลักฐานบอร์ดจริงในภารกิจ">
                    <div className="section-micro">REAL BOARD CHECKPOINT / INDEPENDENT OF SCORE</div>
                    <div className="hw-check-header"><h3>{active === 1 ? 'ตรวจเส้นทางข้อมูลจากบอร์ด' : active === 2 ? 'ตรวจการส่งข้อมูลของ Cucumber R' : 'ตรวจ JSON ที่บอร์ดส่งมาจริง'}</h3><span className={hardwareLive ? 'hw-on' : 'hw-off'}>{hardwareLive ? '● STREAM LIVE' : '○ NO LIVE STREAM'}</span></div>
                    <p className="hw-explain">{active === 1 ? 'ทดสอบว่ามีข้อความจาก ESP32-S2 ผ่าน USB Serial → Hardware Monitor → เกม อย่างน้อย 2 ข้อความ' : active === 2 ? 'ตรวจได้ว่ามีข้อความจากบอร์ดผ่าน Serial แต่ไม่ได้พิสูจน์ขา GPIO หรืออุปกรณ์ต่อภายนอก' : 'ตรวจ JSON จากพอร์ต Serial: temperature, humidity, soil_moisture และ plant_name โดย null ใช้แทนเซนเซอร์ที่ยังไม่มี (ต่างจากโจทย์ HTTP ตัวอย่าง)'}</p>
                    {hardwareLive && hardware ? (
                      <div className="hw-current"><span>LAST DATA {new Date(hardware.timestamp).toLocaleTimeString('th-TH')}</span><span>T {hardware.payload.temperature ?? '—'}°C</span><span>RH {hardware.payload.humidity ?? '—'}%</span><span>SOIL {hardware.payload.soil_moisture ?? '—'}</span><span>PACKETS {packetCount}</span></div>
                    ) : <p className="help-text">เปิดแท็บ Hardware Monitor และเลือก COM3 (หรือพอร์ตของบอร์ด) ก่อน</p>}
                    {active === 3 && hardwareLive && hardware && <pre className="hw-json">{JSON.stringify(hardware.payload, null, 2)}</pre>}
                    <div className="hw-check-actions"><button className="action-outline" type="button" onClick={verifyMissionHardware}>VERIFY BOARD STREAM ↗</button><span>ไม่ส่งคำสั่งควบคุมบอร์ด / ไม่เพิ่มคะแนน</span></div>
                    {hardwareEvidence[active] && <p className="hw-proof">✓ บันทึกหลักฐานการรับข้อมูลในแท็บนี้แล้ว เวลา {new Date(hardwareEvidence[active]).toLocaleTimeString('th-TH')}</p>}
                    {hardwareMissionFeedback && (!hardwareMissionFeedback.ok || hardwareLive) && <div className={`feedback ${hardwareMissionFeedback.ok ? 'success' : 'fail'}`} role="status"><strong>{hardwareMissionFeedback.ok ? '✓ BOARD STREAM CHECK PASSED' : '! BOARD STREAM CHECK NOT PASSED'}</strong><p>{hardwareMissionFeedback.text}</p></div>}
                    <p className="help-text">การตรวจนี้ยืนยันเพียงการรับข้อมูลและรูปแบบ JSON จากพอร์ต Serial (ยอมรับ null เมื่อไม่มีเซนเซอร์) ไม่ยืนยัน GPIO/เซนเซอร์จริง และไม่ใช้ตัดสินคะแนนเกม</p>
                  </section>
                )}
                <section className="puzzle-card"><div className="section-micro">02 / INTERACTIVE PUZZLE</div>
                  {active === 1 && <div className="puzzle-block"><h3>เรียงลำดับ Data Pipeline</h3><p>คลิกเลือกกล่องตามลำดับที่ข้อมูล Telemetry เดินทางจากอุปกรณ์ถึงหน้าจอ</p><div className="selection-row">{components.map(name => <button key={name} className="chip" disabled={answers.pipeline.includes(name)} onClick={() => patch('pipeline', [...answers.pipeline, name])}>+ {name}</button>)}</div><div className="answer-chain">{answers.pipeline.length ? answers.pipeline.map((name, index) => <span key={name}>{index > 0 && <i>→</i>}<b>{name}</b></span>) : <span className="empty-hint">CLICK NODES TO BUILD A DATA FLOW...</span>}</div><button className="mini-button" onClick={() => patch('pipeline', [])}>↺ RESET ORDER</button></div>}
                  {active === 2 && <div className="puzzle-block"><h3>เลือก GPIO ให้ตรงกับอุปกรณ์</h3><p>อ้างอิงแผนผังของบอร์ด Cucumber R ที่ใช้งานในโครงงาน</p><div className="fields-grid">{([['statusPin', 'STATUS LED (IO2)'], ['rgbPin', 'RGB WS2812'], ['bootPin', 'BOOT BUTTON (IO0)']] as const).map(([key, label]) => <label key={key}>{label}<select value={answers[key]} onChange={event => patch(key, event.target.value)}><option value="">SELECT GPIO</option><option>GPIO0</option><option>GPIO2</option><option>GPIO18</option><option>GPIO19</option><option>GPIO20</option></select></label>)}</div><p className="help-text">หมายเหตุ: ยังไม่ได้สั่งเปิด LED จริง การจับคู่ครั้งนี้เป็นปริศนาเชิงทฤษฎี</p></div>}
                  {active === 3 && <div className="puzzle-block"><h3>กู้คืน Telemetry API</h3><p>ตั้งค่า HTTP Method/Endpoint และตรวจสอบ JSON ตัวอย่างสำหรับการอ่านสถานะบอร์ด</p><div className="fields-grid"><label>METHOD<select value={answers.httpMethod} onChange={e => patch('httpMethod', e.target.value)}><option>GET</option><option>POST</option><option>DELETE</option></select></label><label>ENDPOINT<input value={answers.endpoint} placeholder="/status" onChange={e => patch('endpoint', e.target.value)} /></label></div><label className="full-label">JSON RESPONSE (MOCK)<textarea spellCheck={false} value={answers.telemetry} rows={5} onChange={e => patch('telemetry', e.target.value)} /></label><p className="help-text">Schema: device = cucumber-r, uptime_s เป็นตัวเลขไม่ติดลบ, rssi_dbm เป็นตัวเลขติดลบ</p></div>}
                  {active === 4 && <div className="puzzle-block"><h3>แปลคำสั่งมนุษย์เป็น JSON</h3><p>พิมพ์คำสั่งให้ไฟเปลี่ยนเป็นสีน้ำเงิน จากนั้นระบุประเภท Intent ที่ถูกต้อง</p><label className="full-label">NATURAL LANGUAGE COMMAND<input value={answers.aiInstruction} placeholder="เช่น เปลี่ยนไฟเป็นสีน้ำเงิน" onChange={e => patch('aiInstruction', e.target.value)} /></label><div className="terminal-preview"><div>DETERMINISTIC PARSER OUTPUT // NOT A REAL LLM</div><pre>{JSON.stringify(aiResult ?? { intent: 'UNKNOWN', error: 'No supported command detected' }, null, 2)}</pre></div><div className="terminal-preview"><div>LOCAL AI INTENT CLASSIFIER // NAIVE BAYES (TRAINED ON EXAMPLES)</div><pre>{JSON.stringify(localMlResult, null, 2)}</pre><p className="help-text">โมเดล ML ขนาดเล็กรันใน Browser บน PC/มือถือ ไม่ใช่ LLM • ผลทำนายเป็นเพื่อการเรียนรู้ ไม่ใช่คำสั่งเปิด LED จริง และไม่ใช้ตรวจคะแนน</p></div><label className="full-label">EXPECTED INTENT<select value={answers.expectedIntent} onChange={e => patch('expectedIntent', e.target.value)}><option value="">SELECT INTENT</option><option value="SET_RGB">SET_RGB</option><option value="RESTART">RESTART</option><option value="GET_STATUS">GET_STATUS</option></select></label></div>}
                  {active === 5 && <div className="puzzle-block"><h3>RGB CIPHER: CYAN SIGNAL</h3><p>ตั้งค่าสีตามรหัส: RED = 0, GREEN = 2 × 90, BLUE = 255</p><div className="rgb-layout"><div className="rgb-fields">{([['red', 'R / RED'], ['green', 'G / GREEN'], ['blue', 'B / BLUE']] as const).map(([key, label]) => <label key={key}>{label}<input type="number" min="0" max="255" step="1" value={answers[key]} onChange={e => patch(key, e.target.value)} /></label>)}</div><div className="led-device"><div className="led-glow" style={{ background: ledPreview, boxShadow: `0 0 45px ${ledPreview}` }} /><span>WS2812 / VIRTUAL LED</span></div></div><p className="help-text">ค่าทุกช่องต้องเป็นจำนวนเต็มระหว่าง 0–255 การแสดงสีนี้เป็นภาพจำลองบนเว็บ</p></div>}
                  {active === 6 && <div className="puzzle-block"><h3>ENTER THE FINAL ACCESS TOKEN</h3><p>ใช้ข้อมูล Telemetry จำลอง: uptime_s = 120 และ rssi_dbm = −55</p><div className="terminal-preview"><div>FINAL TOKEN RULE</div><pre>ABS(RSSI) + UPTIME = ?</pre></div><label className="full-label">ACCESS TOKEN<input inputMode="numeric" value={answers.accessCode} placeholder="3-digit code" onChange={e => patch('accessCode', e.target.value)} /></label><h3>CONFIRM RGB SEQUENCE</h3><p>คลิกสัญญาณตามลำดับ BLUE → GREEN → RED</p><div className="selection-row">{['RED', 'GREEN', 'BLUE'].map(color => <button key={color} className={`chip chip-${color.toLowerCase()}`} disabled={answers.sequence.length >= 3} onClick={() => patch('sequence', [...answers.sequence, color])}>+ {color}</button>)}</div><div className="answer-chain">{answers.sequence.length ? answers.sequence.join(' → ') : 'NO SIGNALS SENT'}</div><button className="mini-button" onClick={() => patch('sequence', [])}>↺ RESET SEQUENCE</button></div>}
                  <div className="verify-row"><button className="action-primary" onClick={checkMission}>VERIFY SOLUTION <span>↗</span></button><span>Deterministic rule check / No hardware writes</span></div>
                  {feedback && <div className={`feedback ${feedback.ok ? 'success' : 'fail'}`} role="status"><strong>{feedback.ok ? '✓ VALIDATION PASS' : '! VALIDATION FAILED'}</strong><p>{feedback.text}</p></div>}
                </section>
                {finished.includes(active) && <section className="debrief-card"><div className="section-micro">03 / DEBRIEF & ENGINEERING INSIGHT</div><h3>MISSION VERIFIED</h3><p>{active === 1 ? 'ระบบ AIoT ประกอบด้วย Edge, Gateway, AI และ UI ซึ่งมีหน้าที่ต่างกันและต้องตรวจสอบทิศทางข้อมูล' : active === 2 ? 'GPIO ของบอร์ดจริงต้องยืนยันจาก Pinout ของรุ่นที่ใช้งาน ก่อนเขียน Firmware หรือเชื่อมต่ออุปกรณ์' : active === 3 ? 'HTTP Method, Endpoint และ JSON Schema เป็นสัญญาร่วมกันระหว่างอุปกรณ์กับระบบที่รับข้อมูล' : active === 4 ? 'AI ควรทำหน้าที่ตีความเท่านั้น ก่อนสั่งอุปกรณ์ต้องมี Schema Validation และกฎตรวจสอบอิสระ' : active === 5 ? 'WS2812 ใช้ข้อมูลสี 8 บิตต่อช่อง การตรวจค่าและ ACK บนอุปกรณ์จริงเป็นคนละขั้นกับภาพจำลอง' : 'การทำงาน AIoT ที่เชื่อถือได้ต้องตรวจเงื่อนไขจริงและรับ ACK จากอุปกรณ์ ไม่ใช้คำตอบของ AI เป็นหลักฐานเพียงอย่างเดียว'}</p>{active < 6 && <button className="action-outline" onClick={() => openMission(active + 1)}>UNLOCK NEXT MISSION →</button>}{active === 6 && <button className="action-outline" onClick={() => setPage('home')}>VIEW COMPLETION REPORT →</button>}</section>}
              </div>
            </div>
          </>
        )}

        {page === 'codex' && <section className="codex-page"><div className="eyebrow">ENGINEERING CODEX / KNOWLEDGE BASE</div><h1>KNOW THE <em>PROTOCOL.</em></h1><p>เอกสารสรุปความรู้สำหรับผู้เรียน โครงงาน CN466 — เรียนด้วยระบบจำลองก่อนต่ออุปกรณ์จริง</p><div className="codex-grid"><article><span>01</span><h3>IoT vs AIoT</h3><p>IoT เน้นเชื่อมต่อและแลกเปลี่ยนข้อมูลจากอุปกรณ์ ส่วน AIoT เพิ่มการตีความหรือช่วยตัดสินใจด้วย AI</p></article><article><span>02</span><h3>Cucumber R / ESP32-S2</h3><p>ศึกษาขาจากแผนผังบอร์ด: GPIO2 ใช้กับ Status LED, GPIO18 กับ RGB WS2812 และ GPIO0 กับ BOOT ตาม Pinout ที่ผู้เรียนตรวจสอบ</p></article><article><span>03</span><h3>HTTP & JSON</h3><p>HTTP กำหนดวิธีเรียกข้อมูล ส่วน JSON กำหนดโครงสร้างข้อมูล ควรตรวจ Schema และค่า Input ก่อนใช้งานจริง</p></article><article><span>04</span><h3>AI Command Safety</h3><p>แยกการตีความของ AI ออกจากการตรวจคำสั่ง การดำเนินการของอุปกรณ์ และการตรวจสอบ ACK</p></article><article><span>05</span><h3>WS2812 RGB</h3><p>ค่า RGB อยู่ในช่วง 0–255 ต่อช่อง การแสดงตัวอย่างบนเว็บยังไม่ใช่หลักฐานว่า LED ของบอร์ดเปลี่ยนสีจริง</p></article><article><span>06</span><h3>Simulation vs Hardware</h3><p>โหมดจำลองใช้ข้อมูลสมมติและตัวตรวจคำตอบแบบกำหนดกฎ โหมดฮาร์ดแวร์จริงต้องมี Gateway, Firmware Protocol และการทดสอบแยกต่างหาก</p></article></div><div className="codex-warning"><strong>DEMO TRANSPARENCY</strong><p>เวอร์ชันนี้เชื่อมข้อมูลที่ Firmware รายงานผ่าน ESP32-S2 → USB Serial → Hardware Monitor → BroadcastChannel ได้แล้ว แต่มีเฉพาะคำสั่ง PING และการตั้งค่า Wi-Fi ผ่าน USB โดยไม่สั่ง GPIO ไม่มี LLM และไม่มีเซนเซอร์ภายนอกที่ยืนยันได้ ภารกิจ M04–M06 และคะแนนเป็น Simulation</p></div><button className="action-primary" onClick={() => openMission(1)}>ENTER MISSION CONTROL →</button></section>}
      </main>
      <footer className="global-footer wrap"><span>© 2026 IoT ESCAPE / CN466 EDUCATIONAL PROJECT</span><span>ESP32-S2 LAB • USB + HOTSPOT v0.4.0</span><button onClick={resetProgress}>RESET TRAINING DATA ↺</button></footer>
    </div>
  )
}

export default App
