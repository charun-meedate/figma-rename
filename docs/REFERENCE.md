# figma-rename — reference

> ภาษาไทย · [English](REFERENCE.en.md)

## สารบัญ

- [rename ได้อะไรบ้าง](#rename-ได้อะไรบ้าง)
- [ขั้นตอน](#ขั้นตอน)
- [มาตรฐานกลางข้ามโปรเจกต์ (`extends`)](#มาตรฐานกลางข้ามโปรเจกต์-extends)
- [ตั้งชื่อ component จากโครงสร้าง](#ตั้งชื่อ-component-จากโครงสร้าง)
- [Smart Suggest — ตั้งชื่อจากค่าของตัวมันเอง](#smart-suggest-ตั้งชื่อจากค่าของตัวมันเอง)
- [จุดที่ skill นี้ "ไม่เดา"](#จุดที่-skill-นี้-ไม่เดา)
- [สิ่งที่ตรวจก่อนลงมือ (`check.mjs`)](#สิ่งที่ตรวจก่อนลงมือ-checkmjs)
- [สถานะการทดสอบ](#สถานะการทดสอบ)
- [โครงสร้าง skill](#โครงสร้าง-skill)

---

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
cp "$S/rename.config.example.json" rename.config.json    # ชี้ไปที่มาตรฐานกลางด้วย extends

# 1. อ่านของที่มีอยู่ออกจาก Figma (use_figma read-only → rename/inventory.json)
#    สคริปต์อยู่ใน references/inventory.md — Claude จะรันให้

# 2. เสนอชื่อใหม่ → rename-map.json  (นี่คือ "ข้อเสนอ" ต้องอ่านก่อน)
node "$S/plan.mjs" --kind variable

# 3. ตัดสินทีละกลุ่ม — ตัวที่ยังไม่ตัดสิน ยิงขึ้น Figma ไม่ได้
node "$S/review.mjs" list --batch variable-2-semantic
node "$S/review.mjs" accept --batch variable-2-semantic --rule strip-color-prefix

# 4. ตรวจก่อนแตะอะไรเลย
node "$S/check.mjs" --code

# 5. ลงมือใน Figma ทีละ batch (พิมพ์สคริปต์ให้เอาไปใส่ use_figma)
node "$S/emit-figma.mjs" --batch variable-2-semantic
node "$S/review.mjs" mark variable-2-semantic --figma-applied   # หลัง use_figma สำเร็จ

# 6. ดึง dumps ใหม่จาก Figma ก่อน แล้วค่อย regenerate + codemod
node ".claude/skills/figma-token-export/scripts/sync.mjs" dumps/*.json
node "$S/apply-code.mjs" --batch variable-2-semantic            # dry run ก่อนเสมอ
node "$S/apply-code.mjs" --batch variable-2-semantic --write

# 7. ตรวจ แล้ว mark แล้ว commit
node "$S/check.mjs" --after
node "$S/review.mjs" mark variable-2-semantic --applied
```

สถานะของ batch เดินทางเดียว `planned → figma-applied → applied` และเลื่อนด้วยคำสั่ง
เท่านั้น สถานะอยู่ใน map ซึ่งอยู่ใน commit เดียวกับโค้ด — `git revert` จึงคืนสถานะให้เอง

ย้อนกลับ: `node "$S/emit-figma.mjs" --batch <id> --reverse` แล้ว `git revert` commit นั้น

## มาตรฐานกลางข้ามโปรเจกต์ (`extends`)

`rename.config.json` ของแต่ละโปรเจกต์ควรมีแค่ข้อเท็จจริงของโปรเจกต์นั้น ส่วนกฎการตั้งชื่อ
อยู่ในไฟล์เดียวที่ทุกโปรเจกต์ `extends`:

```jsonc
{ "extends": "aurora",                       // preset ที่มากับ skill
  "extends": "../design-system/naming.json"  // หรือไฟล์กลางของทีม (path จาก config)
}
```

การ merge เป็นแบบตื้นทีละบล็อก และ **array ทับ ไม่ใช่ต่อท้าย** — ถ้าโปรเจกต์เขียน
`convention.rules` เอง กฎของไฟล์กลางจะหายทั้งชุด ไม่ใช่ถูกเพิ่มเข้าไป ตั้งใจให้เป็นแบบนี้
เพราะ "เอาชุดนี้ ไม่เอาชุดนั้น" ต้องพูดได้ ถ้าต่อท้ายให้อัตโนมัติ กฎที่โปรเจกต์ตั้งใจตัดทิ้ง
จะยังทำงานอยู่ แล้วดูเหมือนมาตรฐานกลางเพี้ยนเอง

ผลที่ตามมาที่ต้องรู้: **อย่าเขียน `rules` บางส่วนลงในโปรเจกต์** ถ้าจะเพิ่มกฎหนึ่งข้อ
ต้องยกมาทั้งชุดแล้วเติม — ซึ่งแปลว่าคุณเพิ่งก๊อป convention ลงโปรเจกต์ไปแล้ว ทางที่ถูกคือ
ไปเพิ่มที่ไฟล์กลาง ทุกกฎถูกแท็กว่ามาจากไฟล์ไหน เวลาคอมไพล์กฎพัง error จะบอกชื่อไฟล์ต้นทาง
ไม่ใช่แค่ `rules[3]`

preset ที่มีมาให้: `starter` (หลวม เหมาะกับไฟล์แรก) · `aurora` (เข้มงวด มี component
vocabulary ครบ) วางไฟล์ preset ของทีมไว้ที่ `presets/` แล้วอ้างด้วยชื่อได้เลย

`convention.transform` คือขั้นตัดแต่งก่อนเข้ากฎ — `stripPrefix` `stripSuffix` `addPrefix`
`separator` `replace` ทั้งหมด**ทำซ้ำแล้วได้ผลเดิม** และจะไม่ยอมตัดจนชื่อเหลือว่าง
ส่วนตัวพิมพ์กับสเกลตัวเลขไม่ได้อยู่ในนี้ — มันคือ `segmentCase` กับ `sizeNaming`

## ตั้งชื่อ component จากโครงสร้าง

token ตั้งชื่อจากค่าได้ แต่ component ไม่มี "ค่า" ให้ดู มันมีแต่โครงสร้าง — ข้างในมีอะไร
ซ้อนกันกี่ชั้น มีข้อความไหม auto-layout วางแนวไหน `lib/classify.mjs` เอาสัญญาณพวกนี้
ใส่กฎ 50 ข้อที่เรียงตามลำดับความสำคัญ แล้วตอบว่าน่าจะเป็น component ชนิดไหน

```
Frame 427   -> Button      [high]   มีข้อความ 1 ตัว, พื้นหลังโค้ง, ไม่มีลูกที่เป็น input
Group 12    -> Modal       [medium] overlay + ปุ่มปิด + ลูกซ้อน 3 ชั้น
```

ปรับได้ที่ `convention.components.classifier` ใน preset — `minConfidence` ตัดตัวที่มั่นใจต่ำ
`priorities` เลื่อนลำดับกฎทีละข้อ `pageHints` ใช้ชื่อหน้าเป็นสัญญาณเสริม `disable` ปิดกฎที่
ให้ผลผิดกับไฟล์คุณ ทั้งหมดเป็นข้อมูล ไม่ต้องแก้ JS

กฎพวกนี้ต้องการ `signature` ของแต่ละ component ซึ่งเก็บมาตอน inventory
(สคริปต์อยู่ใน `references/inventory.md`) ถ้าไม่มี signature component จะไม่ถูกเสนอชื่อ

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

`node skills/figma-rename/scripts/selftest.mjs` — 164 เคส ผ่านหมด ครอบคลุม
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

ทดสอบกับไฟล์ Figma จริงแล้ว — อ่าน variable 1,148 ตัว, rename 1 ตัว แล้ว reverse กลับ
ตอน rename มี semantic token อ้างถึงตัวนั้นอยู่ 14 ตัว ไม่พังสักตัว ซึ่งเป็นข้ออ้างที่ skill ทั้งตัว
ตั้งอยู่บนมัน — ตอนนี้วัดแล้ว ไม่ใช่แค่เชื่อ

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
    ├── review.mjs               ตัดสิน accept/reject/resolve + เลื่อนสถานะ batch
    ├── check.mjs                ปฏิเสธ map ที่จะพัง (+ --code, --after)
    ├── emit-figma.mjs           batch → สคริปต์สำหรับ use_figma (+ --reverse)
    ├── apply-code.mjs           codemod ทั้ง repo (dry-run เป็น default)
    ├── selftest.mjs             164 เคส
    ├── rename.config.example.json
    └── lib/
        ├── suggest.mjs          value → ชื่อ (สี/ตัวเลข) + calibration
        ├── classify.mjs         โครงสร้าง component → ชนิด (Button/Modal/…)
        ├── handoff.mjs          cross-check กับ tokens.config.json
        ├── convention.mjs       rule + normalizer
        ├── codemod.mjs          การสะกดในโค้ด + การแทนที่พร้อมกัน
        └── …
```

> `lib/naming.mjs` ถูก copy ไว้ทั้งสอง skill โดยตั้งใจ — codemod ต้องสะกด identifier ให้ตรงกับที่
> generator เขียนออกมาเป๊ะ ๆ ถ้าเพี้ยนกันเมื่อไหร่ codemod จะไปเปลี่ยนชื่อเป็นสิ่งที่ไม่มีใคร generate
> `selftest.mjs` ของ figma-rename เลยเช็คว่าฟังก์ชันที่ใช้ร่วมกันเหมือนกันทุกตัวอักษร แก้ที่หนึ่งต้องแก้อีกที่
