# figma-rename — reference

> ภาษาไทย · [English](REFERENCE.en.md)

เปลี่ยนชื่อ token / component ใน Figma พร้อม sync ชื่อในโค้ดให้ตรงกัน
เอกสารนี้อธิบายว่าแต่ละอย่างทำงานยังไงและทำไม
ถ้าเพิ่งเริ่ม อ่าน [GETTING-STARTED.md](GETTING-STARTED.md) ก่อน

มาจาก PoC เรื่อง Rename Tokens (7 ขั้น 4 ช่วง) ทำให้เป็นขั้นตอนที่รันซ้ำได้และย้อนได้

**ปัญหาหลักมีข้อเดียว:**

```
Figma ผูกด้วย id   →  เปลี่ยนชื่อแล้วไม่พังอะไรเลย
โค้ดผูกด้วยชื่อ    →  เปลี่ยนชื่อแล้วพังทุกที่ที่อ้างถึง
```

การ rename จึงไม่ใช่ "งานใน Figma" แต่เป็น **การเปลี่ยนแปลงหนึ่งก้อนที่ต้องลงทั้งสองฝั่งพร้อมกัน**
skill นี้บังคับให้ทำทีละก้อน (batch) ก้อนละ 1 commit — ตรงกับขั้น 5–6 ในสไลด์

## rename ได้อะไรบ้าง

Variables (token), Component / Component Set, layer ข้างใน component, Text / Effect / Paint styles

## ขั้นตอน

```bash
S=".claude/skills/figma-rename/scripts"
cp "$S/rename.config.example.json" rename.config.json    # ตั้ง naming convention ที่นี่

# 1. อ่านของที่มีอยู่ออกจาก Figma (use_figma read-only → rename/inventory.json)
#    สคริปต์อยู่ใน references/inventory.md — Claude จะรันให้

# 2. เสนอชื่อใหม่ → rename-map.json  (นี่คือ "ข้อเสนอ" ต้องอ่านก่อน)
node "$S/plan.mjs" --kind variable

# 3. ตรวจก่อนแตะอะไรเลย
node "$S/check.mjs" --code

# 4. ลงมือใน Figma ทีละ batch (พิมพ์สคริปต์ให้เอาไปใส่ use_figma)
node "$S/emit-figma.mjs" --batch variable-2-semantic

# 5. regenerate token แล้วตามด้วย codemod โค้ดที่เรียกใช้
node ".claude/skills/figma-token-export/scripts/sync.mjs" dumps/*.json
node "$S/apply-code.mjs" --batch variable-2-semantic            # dry run ก่อนเสมอ
node "$S/apply-code.mjs" --batch variable-2-semantic --write

# 6. ตรวจแล้ว commit
node "$S/check.mjs" --after
```

ย้อนกลับ: `node "$S/emit-figma.mjs" --batch <id> --reverse` แล้ว `git revert` commit นั้น

## Smart Suggest — ตั้งชื่อจากค่าของตัวมันเอง

ถ้า inventory เก็บ **ค่า** มาด้วย (ไม่ใช่แค่ชื่อ) `plan.mjs` จะมีแหล่งที่สองมาช่วยเสนอชื่อ:

```
Value 1      -> spacing/md       [high]   collection "Spacing"; scope GAP; value 16 หารด้วย 4 ลงตัว
weight-bold  -> fontWeight/bold  [high]   scope FONT_WEIGHT; ชื่อมีคำว่า weight-bold; 700 อยู่ในสเกล 100–900
heading      -> fontSize/2xl     [medium] scope FONT_SIZE; 24 อยู่ในช่วง type scale
dark bg      -> colors/gray/900  [medium] chroma ต่ำ (9%) อมน้ำเงิน L:11% — เทาอมสีหรือน้ำเงินจางมาก ตรวจก่อน
Variable 3   -> opacity/50       [low]    0.5 อยู่ในช่วง 0–1
```

`{r:.231, g:.510, b:.965}` คือน้ำเงิน L=60% — อันนี้เป็น**เลขคณิต** ถูกทุกครั้ง รัน 700 ตัวจบทันที
ฟรี และบอกเหตุผลได้ ให้ LLM มานั่งดู hex ทีละตัวช้ากว่าและพลาดได้ ซึ่งเป็นส่วนผสมที่แย่ที่สุด
สำหรับงาน rename ยกชุด

**สิ่งที่ engine ไม่ทำคือ "ความหมาย"** — น้ำเงินตัวนี้คือ brand หรือ link ไม่มีสูตรไหนตอบได้
พวกนี้ตอบกลับมาว่า **ไม่มีชื่อ + เหตุผล** ให้คนหรือ agent ที่อ่านโค้ดเป็นคนตัดสิน

### 4 จุดที่ spec เดิมใช้ตรง ๆ ไม่ได้

| ปัญหา | ที่ทำแทน |
|---|---|
| `saturation < 10% → gray` พังกับ design system จริง — `#111827` (gray-900) มี saturation **39%**, `#030712` มี **72%** เพราะ saturation พุ่งเมื่อ lightness เข้าใกล้ปลาย | วัดด้วย **chroma** แทน แยก Tailwind gray ได้ **11/11** (เดิม 4/11) |
| ตาราง shade ขัดกับตัวอย่างของตัวเอง — วาง 500 ไว้ที่ L≤55% แต่ตัวอย่างในเอกสาร (Tailwind blue-500) อยู่ที่ L=60% จะได้ `blue/400` | คำนวณตารางใหม่ ตรวจทีละขั้น: **blue 9/11, gray 11/11** |
| ตารางตายตัวใช้กับ palette ทีมไม่ได้ — palette จริงใช้ shade `010/025/075/925/975` และวาง `500` ที่ L=47% ตาราง Tailwind จะให้ `010→50, 025→100` ผิดทั้ง ramp | **เรียน ladder จาก ramp ในไฟล์เอง** แยกราย ramp — palette จริง: เรียนรู้ 15 ramp, round-trip **228/240 (95%)** |
| ตัวอย่างสร้างชื่อซ้ำเอง — `Color 1` กับ `primary` ค่าเดียวกัน ได้ `colors/blue/500` ทั้งคู่ แล้วบอกให้เติม number suffix | ไม่เติม เพราะนั่นคือ **ค่าซ้ำ ไม่ใช่ชื่อชน** → needsReview ว่า *"ควรรวมหรือทำตัวหนึ่งเป็น alias"* |

### กติกาที่ทำให้ review ไหว

- **rule ชนะ suggestion** เมื่อ rule match จริง (สิ่งที่ทีมตัดสิน > สูตร) แต่การ normalize เฉย ๆ
  ไม่ชนะ ไม่งั้น `Color 1` จะกลายเป็น `color-1` แล้วปิดโอกาส `colors/blue/500`
- **confidence ผูกกับจำนวนสัญญาณที่ตรงกัน** — collection → scopes → keyword ในชื่อ → ช่วงค่า
  ถ้ามีแค่ช่วงค่าอย่างเดียวจะไม่มีทางเกิน `low` (เพราะ `8` เป็นได้ทั้ง spacing และ radius)
- **ทุก suggestion มี `reason`** ติดไปใน map — คำถามตอน review เลยกลายเป็น "เหตุผลนี้จริงไหม"
  ซึ่งตอบได้ในวินาทีเดียว แทนที่จะเป็น "ชอบชื่อนี้ไหม" ซึ่งไม่มีใครตอบไหว 300 รอบ
- **ชื่อที่มี group path อยู่แล้ว** (`text/primary/default`) จะไม่ถูกเสนอ ไม่งั้น token ที่ตั้งชื่อดีแล้ว
  ทั้งไฟล์จะโดนเสนอเป็น `colors/gray/900` หมด

รายละเอียดทั้งหมด (ตาราง, threshold, ข้อจำกัดที่รู้อยู่) อยู่ใน
`skills/figma-rename/references/suggest-engine.md`

## จุดที่ skill นี้ "ไม่เดา"

- ชื่อที่ convention ตัดสินไม่ได้ (segment น้อยเกิน / category ไม่รู้จัก) จะออกมาเป็น
  `needsReview` พร้อม `to: null` ให้คนตัดสิน ไม่ใช่เดาให้แล้วรอคนเผลอ approve
- ชื่อ **component ในโค้ด** ไม่ derive ให้ (`btn primary` → `BtnPrimary` เป็นการเดา
  ไม่ใช่การแปลง) จะเสนอเป็น `codeSuggestion` ให้คนยืนยันก่อน — ต่างจาก token ที่
  derive ได้แน่นอนเพราะ generator ทำ transform เดียวกันเป๊ะ
- namespace ที่ **แตกเป็นหลายปลายทาง** จะไม่ rename class ให้ (เช่น `color/**` แตกเป็น
  `text/**` + `surface/**` — ไม่มี class ใหม่ตัวเดียวที่ถูก) ปล่อยให้ compiler ชี้เอง

## สิ่งที่ตรวจก่อนลงมือ (`check.mjs`)

- map เก่าไปแล้ว (`from` ไม่ตรงกับ Figma ปัจจุบัน) → ให้ capture inventory ใหม่
- ชื่อซ้ำใน collection เดียวกัน → Figma reject กลางคัน
- **identifier ชนกันในโค้ด** — `text/primary/default` กับ `text/primary-default` เป็นชื่อ
  ที่ถูกต้องทั้งคู่ใน Figma แต่กลายเป็น `textPrimaryDefault` ตัวเดียวในโค้ด แล้วหายไปเงียบ ๆ
- rename chain (`a→b` ขณะที่ `b→c`) → เตือน แล้ว emit-figma จะพักผ่านชื่อชั่วคราวให้เอง
- `--code` บอกล่วงหน้าว่าแต่ละชื่อจะโดนแก้กี่จุดจริง ๆ (ถ้าโดน 0 จุดทั้งที่รู้ว่าใช้อยู่
  แปลว่า config สะกดผิด — รู้ตอนนี้ถูกกว่ารู้หลังแก้ 400 ไฟล์)

## สถานะการทดสอบ

`node skills/figma-rename/scripts/selftest.mjs` — 84 เคส ผ่านหมด ครอบคลุม
convention/rule template, boundary guard (`--text-primary` ต้องไม่ไปโดน
`--text-primary-default`, `.primaryDefault` ต้องโดนเฉพาะหลังจุด), chain กับ swap
ที่ต้องแทนที่พร้อมกัน, การ refuse ทั้ง 4 แบบของ check (map เก่า / ชื่อซ้ำ / identifier ชน /
namespace แตก), staging + reverse + page switch ของ emit-figma, dry-run vs `--write`,
และ `check --after` ทั้งเคสผ่านและเคสจับได้ว่าลืม regenerate

ฝั่ง suggest engine ทดสอบกับ palette จริง ไม่ใช่ค่าที่แต่งขึ้น — Tailwind blue/gray ครบทั้ง 11 ขั้น
เทียบกับตารางในตัว, ramp production ที่ไม่ใช่ Tailwind เทียบกับ calibration (รวมเคสที่ยืนยันว่า
**ตารางในตัวพังเห็น ๆ** กับ ramp นั้น เพื่อให้เทสจับได้ถ้า calibration ถูกปิดไปเงียบ ๆ),
hue wrap รอบ 0/360, alpha suffix, ลำดับสัญญาณของตัวเลข และทางออก needsReview ทั้งสองแบบ

สคริปต์ที่ `emit-figma.mjs` พิมพ์ออกมาถูก parse เป็น async function body ทุกสาขา
(ปกติ / staged / code-syntax / node+page) — syntax error จะไม่ไปโผล่ตอนยิงเข้า Figma

ยังไม่ได้ยิงกับไฟล์ Figma production จริง — ฝั่ง Figma ทดสอบถึงระดับ "สคริปต์ที่ generate
ออกมาถูกต้องและ parse ได้" เท่านั้น ส่วน codemod ทดสอบกับไฟล์จริงใน temp project

## โครงสร้าง skill

```
skills/figma-rename/
├── SKILL.md                     ไฟล์ที่ Claude Code โหลด
├── figma-rename.md              คู่มือฉบับเต็ม — เนื้อหาหลักอยู่ที่นี่
├── references/
│   ├── naming-convention.md     segment model + วิธีเขียนเป็น rule
│   ├── suggest-engine.md        ตั้งชื่อจากค่า + สิ่งที่มันปฏิเสธจะเดา
│   ├── inventory.md             สคริปต์ use_figma อ่านของที่มีอยู่ (แยกตาม kind)
│   ├── figma-apply.md           ลง batch ใน Figma, atomicity, chain, rollback
│   ├── components.md            component / variant property / layer / Code Connect
│   ├── code-sync.md             การสะกดแต่ละแบบในโค้ด + generated vs hand-written
│   └── rename-map.md            สัญญาของ rename-map.json
├── presets/                     มาตรฐานกลาง (aurora, starter)
├── evals/                       ชุดทดสอบพฤติกรรม 4 อัน
└── scripts/
    ├── plan.mjs                 inventory + convention + suggest → rename-map.json (ข้อเสนอ)
    ├── check.mjs                ปฏิเสธ map ที่จะพัง (+ --code, --after)
    ├── emit-figma.mjs           batch → สคริปต์สำหรับ use_figma (+ --reverse)
    ├── apply-code.mjs           codemod ทั้ง repo (dry-run เป็น default)
    ├── selftest.mjs             84 เคส
    ├── rename.config.example.json
    └── lib/
        ├── suggest.mjs          value → ชื่อ (สี/ตัวเลข) + calibration
        ├── convention.mjs       rule + normalizer
        ├── codemod.mjs          การสะกดในโค้ด + การแทนที่พร้อมกัน
        └── …
```

> `lib/naming.mjs` ถูก copy ไว้ทั้งสอง skill โดยตั้งใจ — codemod ต้องสะกด identifier ให้ตรงกับที่
> generator เขียนออกมาเป๊ะ ๆ ถ้าเพี้ยนกันเมื่อไหร่ codemod จะไปเปลี่ยนชื่อเป็นสิ่งที่ไม่มีใคร generate
> `selftest.mjs` ของ figma-rename เลยเช็คว่าฟังก์ชันที่ใช้ร่วมกันเหมือนกันทุกตัวอักษร แก้ที่หนึ่งต้องแก้อีกที่
