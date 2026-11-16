/**
 * Educational on-device machine learning demo — not a cloud LLM.
 * Multinomial Naive Bayes trained on a tiny, openly visible collection of
 * Thai/English command examples. No secret keys, network, or hardware writes.
 * M04 grading remains handled by the original validated deterministic rules.
 */
export type MiniIntent = 'SET_RGB' | 'GET_STATUS' | 'RESTART' | 'NO_ACTION'

const examples: ReadonlyArray<readonly [MiniIntent, string]> = [
  ['SET_RGB', 'เปลี่ยนไฟเป็นสีน้ำเงิน'],
  ['SET_RGB', 'ให้ไฟ LED เป็นสีฟ้า'],
  ['SET_RGB', 'ตั้ง RGB สีแดง'],
  ['SET_RGB', 'เปลี่ยนสีหลอดไฟเป็นเขียว'],
  ['SET_RGB', 'เปิดไฟสีฟ้าที'],
  ['SET_RGB', 'ปรับสีไฟเป็นม่วง'],
  ['SET_RGB', 'สั่งให้ไฟ LED เปลี่ยนสี'],
  ['SET_RGB', 'change the RGB LED color'],
  ['SET_RGB', 'set the light to blue'],
  ['SET_RGB', 'turn on the blue light'],
  ['SET_RGB', 'make led green'],
  ['GET_STATUS', 'ตรวจสอบสถานะของบอร์ด'],
  ['GET_STATUS', 'ขอสถานะ Wi-Fi'],
  ['GET_STATUS', 'ดูค่าเซนเซอร์ล่าสุด'],
  ['GET_STATUS', 'อ่านข้อมูลอุปกรณ์'],
  ['GET_STATUS', 'รายงานสถานะ ESP32'],
  ['GET_STATUS', 'เช็กว่าอุปกรณ์เชื่อมต่อไหม'],
  ['GET_STATUS', 'อุณหภูมิเท่าไร'],
  ['GET_STATUS', 'get device status'],
  ['GET_STATUS', 'check wifi connection'],
  ['GET_STATUS', 'read sensor telemetry'],
  ['GET_STATUS', 'show board status'],
  ['RESTART', 'รีสตาร์ทบอร์ด'],
  ['RESTART', 'สั่งเริ่มระบบใหม่'],
  ['RESTART', 'ช่วยรีบูต ESP32'],
  ['RESTART', 'รีเซ็ตอุปกรณ์'],
  ['RESTART', 'บูตบอร์ดใหม่'],
  ['RESTART', 'restart device'],
  ['RESTART', 'reboot ESP32 board'],
  ['RESTART', 'reset the controller'],
  ['RESTART', 'please restart the board'],
  ['NO_ACTION', 'สวัสดีครับ'],
  ['NO_ACTION', 'เรียนรู้ระบบ AIoT'],
  ['NO_ACTION', 'นี่เป็นโจทย์แบบฝึกหัด'],
  ['NO_ACTION', 'ไม่ต้องเปิดไฟ'],
  ['NO_ACTION', 'ห้ามเปลี่ยนสี LED'],
  ['NO_ACTION', 'อย่ารีเซ็ตอุปกรณ์'],
  ['NO_ACTION', 'hello how are you'],
  ['NO_ACTION', 'this is just a test'],
  ['NO_ACTION', 'do not turn on any lights'],
]
const labels: MiniIntent[] = ['SET_RGB', 'GET_STATUS', 'RESTART', 'NO_ACTION']
const grams = (sentence: string) => {
  const chars = Array.from(sentence.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' '))
  const tokens: string[] = []
  for (const size of [2, 3, 4]) {
    for (let i = 0; i + size <= chars.length; i++) tokens.push(chars.slice(i, i + size).join(''))
  }
  return tokens
}
const counts = Object.fromEntries(labels.map(l => [l, new Map<string, number>()])) as Record<MiniIntent, Map<string, number>>
const totals = Object.fromEntries(labels.map(l => [l, 0])) as Record<MiniIntent, number>
const prior = Object.fromEntries(labels.map(l => [l, 0])) as Record<MiniIntent, number>
const vocabulary = new Set<string>()
for (const [label, sentence] of examples) {
  prior[label] += 1
  for (const token of grams(sentence)) {
    vocabulary.add(token)
    const table = counts[label]
    table.set(token, (table.get(token) ?? 0) + 1)
    totals[label] += 1
  }
}

export function predictIntent(text: string): {intent: MiniIntent | 'UNKNOWN', confidence: number, runtime: string} {
  const input = text.trim()
  if (input.length < 3) return {intent: 'UNKNOWN', confidence: 0, runtime: 'BROWSER_LOCAL_NAIVE_BAYES'}
  // Independent safeguard, not a learned model decision; never let a negated
  // statement be treated as a valid instruction to actuate hardware.
  if (/ไม่ต้อง|อย่า|ห้าม|do not|don.t|never/i.test(input)) {
    return {intent:'NO_ACTION', confidence:1, runtime:'BROWSER_LOCAL_NAIVE_BAYES + SAFETY_RULE'}
  }
  const features = grams(input)
  if (!features.length) return {intent:'UNKNOWN',confidence:0,runtime:'BROWSER_LOCAL_NAIVE_BAYES'}
  const totalExamples = examples.length
  const scores = labels.map(label => {
    let logScore = Math.log(prior[label] / totalExamples)
    const denom = totals[label] + vocabulary.size
    for (const token of features) logScore += Math.log(((counts[label].get(token) ?? 0) + 1) / denom)
    return logScore
  })
  const max = Math.max(...scores)
  const probabilities = scores.map(value => Math.exp(value - max))
  const sum = probabilities.reduce((a,b) => a+b,0)
  const ranked = probabilities.map((v,i) => ({label: labels[i], probability: v/sum})).sort((a,b)=>b.probability-a.probability)
  return {intent: ranked[0].probability >= 0.5 ? ranked[0].label : 'UNKNOWN',
    confidence: Number(ranked[0].probability.toFixed(3)), runtime:'BROWSER_LOCAL_NAIVE_BAYES'}
}
