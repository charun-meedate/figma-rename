# ดูแล figma-rename — สำหรับคนที่รันสคริปต์เอง / แก้ตัว skill

> ภาษาไทย · [English](MAINTAINING.en.md)
> แค่จะใช้งาน ไม่ได้จะรันสคริปต์เอง → [GETTING-STARTED.md](GETTING-STARTED.md)
> อยากรู้ว่าทำไมมันทำงานแบบนั้น → [REFERENCE.md](REFERENCE.md)

## สารบัญ

- [โครงสร้าง](#โครงสร้าง)
- [รันสคริปต์เอง](#รันสคริปต์เอง)
- [config ขั้นต่ำ](#config-ขั้นต่ำ)
- [ลำดับที่ห้ามสลับ](#ลำดับที่ห้ามสลับ)
- [ตารางแก้ปัญหา](#ตารางแก้ปัญหา)
- [ข้อจำกัดที่ยืนยันแล้ว](#ข้อจำกัดที่ยืนยันแล้ว)
- [แก้ตัว skill](#แก้ตัว-skill)
- [อ่านต่อ](#อ่านต่อ)

---

---

## โครงสร้าง

```
skills/figma-rename/
├── SKILL.md                     ไฟล์ที่ Claude Code โหลด (frontmatter + ชี้ไปคู่มือ)
├── figma-rename.md              คู่มือฉบับเต็ม — เนื้อหาหลักอยู่ที่นี่
├── references/                  โหลดเมื่อจำเป็น
│   ├── naming-convention.md     segment model + วิธีเขียนเป็น rule
│   ├── suggest-engine.md        ตั้งชื่อจากค่า + สิ่งที่มันปฏิเสธจะเดา
│   ├── inventory.md             สคริปต์ use_figma อ่านของที่มีอยู่ (แยกตาม kind)
│   ├── figma-apply.md           ลง batch ใน Figma, atomicity, chain, rollback
│   ├── components.md            component / variant property / layer / Code Connect
│   ├── code-sync.md             การสะกดแต่ละแบบในโค้ด + generated vs hand-written
│   └── rename-map.md            สัญญาของ rename-map.json
└── scripts/                     Node 18+ ไม่มี dependency
```

**สคริปต์อยู่ใน skill ไม่ใช่ในโปรเจกต์** ส่วนไฟล์ข้อมูล (`rename.config.json`,
`rename/inventory.json`, `rename/rename-map.json`) อยู่ใน**โปรเจกต์** และ resolve จาก
ตำแหน่งของ `rename.config.json` ไม่ใช่ cwd เลยรันจากที่ไหนก็ได้

```bash
S=".claude/skills/figma-rename/scripts"          # ติดตั้งเข้าโปรเจกต์แล้ว
# S="$HOME/.claude/skills/figma-rename/scripts"  # ติดตั้งแบบ --global
```

---

## รันสคริปต์เอง

ทุกสคริปต์รับ `--help` และตอบได้โดยไม่ต้องมี config — รายการ flag เต็มอยู่ที่นั่น
ข้างล่างนี้คือตัวที่ใช้บ่อย

```bash
cp "$S/rename.config.example.json" rename.config.json    # ครั้งเดียวต่อโปรเจกต์

# 1. inventory — ขั้นนี้รันเองไม่ได้ ต้องผ่าน use_figma (ดู references/inventory.md)

node "$S/capture-css.mjs" src/styles.css   # source: code — inventory from CSS

# 2. เสนอชื่อใหม่
node "$S/plan.mjs"                          # ทุก kind ใน config.kinds
node "$S/plan.mjs" --kind variable          # เฉพาะ variable
node "$S/plan.mjs" --only "color/**"        # เฉพาะบางชื่อ
node "$S/plan.mjs" --max-batch 25           # batch เล็กลง
node "$S/plan.mjs" --min-confidence medium  # ตัด suggestion ที่มั่นใจต่ำ
node "$S/plan.mjs" --no-suggest             # ใช้แต่กฎใน convention
node "$S/plan.mjs" --dry-run                # พิมพ์สรุป ไม่เขียนไฟล์

# 3. ตัดสิน (review.mjs เป็นตัวเดียวที่เขียน decision/status ได้)
node "$S/review.mjs" status                            # ทุก batch: สถานะ + จำนวน
node "$S/review.mjs" list --batch <id> --pending       # อ่านเต็ม ไม่ตัดบรรทัด
node "$S/review.mjs" accept --batch <id> --rule <ชื่อกฎ>
node "$S/review.mjs" accept --batch <id> --min-confidence medium
node "$S/review.mjs" reject --batch <id> --ids a,b,c
node "$S/review.mjs" set-to <id> --to "text/primary"   # แก้ข้อเสนอ (source: human)
node "$S/review.mjs" resolve <id> --to "brand/primary" # needsReview → เข้า batch
node "$S/review.mjs" skip <id>                         # ปล่อยไว้ และไม่โผล่ซ้ำตอน re-plan

# 4. ตรวจก่อนแตะอะไร
node "$S/check.mjs"           # เทียบกับ inventory
node "$S/check.mjs" --code    # + สแกน repo ว่าจะโดนแก้กี่จุด
node "$S/check.mjs" --code --no-namespace-classes   # ข้ามชื่อ class ที่ generator สร้าง

# 5. สร้างสคริปต์สำหรับ Figma
node "$S/emit-figma.mjs" --batch <id>
node "$S/emit-figma.mjs" --batch <id> --with-code-syntax   # เขียนชื่อโค้ดกลับเข้า Figma
node "$S/emit-figma.mjs" --batch <id> --reverse            # rollback
node "$S/review.mjs" mark <id> --figma-applied            # หลัง use_figma สำเร็จ

# 6. ดึง dumps ใหม่ → regenerate → codemod
node "$S/apply-code.mjs" --batch <id>                    # dry run (default)
node "$S/apply-code.mjs" --batch <id> --write
node "$S/apply-code.mjs" --batch <id> --write --no-namespace-classes

# 7. ยืนยัน
node "$S/check.mjs" --after   # ต้องไม่เหลือชื่อเก่าที่ไหนเลย
node "$S/review.mjs" mark <id> --applied
```

ขั้น 5 พิมพ์ JS ออก stdout — เอาไปใส่ `use_figma` เอง (หรือให้ Claude ทำ)
ส่วน log ไปที่ stderr เลย pipe ต่อได้

---

## config ขั้นต่ำ

```json
{
  "extends": "aurora",
  "figma": { "fileKey": "SjE7hLqGcKYLy4XMgXGhlM" },
  "code": {
    "generated": ["src/tokens/**"],
    "cssPrefix": "",
    "flutterPrefix": "App"
  }
}
```

**`extends` คือหัวใจของการใช้หลายโปรเจกต์** — convention อยู่ในไฟล์กลางไฟล์เดียว
(preset ที่มากับ skill หรือไฟล์ของทีมเอง) โปรเจกต์ override เฉพาะสิ่งที่ต่างจริง
ซึ่งปกติมีแค่ `figma.fileKey` กับ `code.*` ดูผลลัพธ์หลัง merge ด้วย
`node "$S/plan.mjs" --print-config`

convention ที่ copy ไปไว้ในแต่ละโปรเจกต์ ไม่ใช่มาตรฐาน — มันคือมาตรฐานหลายชุดที่บังเอิญ
ตรงกันอยู่วันนี้

**`cssPrefix` และ `flutterPrefix` ต้องตรงกับ `tokens.config.json`** ของ
`figma-token-export` ไม่งั้น codemod จะหาไม่เจอสักที่แล้วเงียบ ๆ ไม่ทำอะไร

`generated` คือไฟล์ที่ generator เขียน — codemod ข้าม เพราะ regenerate จะทับอยู่ดี

---

## ลำดับที่ห้ามสลับ

```
1. rename ใน Figma
2. regenerate token files   (sync.mjs ของ figma-token-export)
3. codemod โค้ดที่เรียกใช้   (apply-code.mjs --write)
4. build / test
5. commit — ทั้งหมดใน commit เดียว
```

ระหว่าง 1–3 tree compile ไม่ผ่าน ปกติ ห้ามแค่ commit ตอนนั้น
`check.mjs --after` ตั้งใจสแกนไฟล์ generated ด้วย เพราะ "consumer สะอาดแต่ tokens.css
ยังเก่า" แปลว่ามีคนข้ามขั้น 2

---

## ตารางแก้ปัญหา

| ข้อความ | สาเหตุ | ทำยังไง |
|---|---|---|
| `rename.config.json not found` | รันนอกโปรเจกต์ หรือยังไม่ได้ copy config | copy จาก example ไปไว้ root |
| `Could not read …/inventory.json` | ยังไม่ได้ capture inventory | ทำผ่าน `use_figma` (references/inventory.md) |
| `re-capture the inventory` | ชื่อใน Figma เปลี่ยนหลัง capture | ดึงใหม่ → plan ใหม่ (อย่าฝืน apply) |
| `"X" would be the name of both A and B` | สองตัวลงชื่อเดียวกันใน collection เดียว | Figma reject อยู่แล้ว แก้ map |
| `Identifier collision` | ชื่อต่างกันใน Figma แต่แบนเป็น identifier เดียวในโค้ด | เปลี่ยนชื่อใดชื่อหนึ่ง |
| `Ambiguous rewrite` | literal เดียวถูกสั่งให้กลายเป็นสองอย่าง | map ใช้ไม่ได้ ต้องแก้ ไม่ใช่เรียงลำดับใหม่ |
| `X spelling(s) matched nothing` | codebase สะกด token คนละแบบกับ `code.spellings` | เช็ค `cssPrefix` / `spellings` ก่อนกด `--write` |
| `built-in ladder (no ramp to learn from)` | inventory ไม่มี `value` หรือ ramp ไม่ได้ลงท้ายด้วยเลข | ดึง value มาด้วย ไม่งั้น shade สีจะเพี้ยน |
| `stranded __rn_tmp_` ใน Figma | batch ที่ stage ชื่อชั่วคราวไว้ค้างกลางทาง | ดึง inventory ใหม่ แล้ว plan จากสภาพจริง |

---


## ถ้า skill เองทำตัวแปลก ๆ

ตารางข้างบนแก้ปัญหาของ *การรัน* ส่วนตารางนี้แก้ปัญหาของ *ตัวสกิล* — เวลาที่สคริปต์ถูกหมด
แต่ agent ไม่เดินตามที่เขียนไว้ ปรับจาก
[make-skill-great](https://github.com/punnaruthaphi/make-skill-great)

| อาการ | สาเหตุที่พบบ่อย | แก้ที่ไหน |
|---|---|---|
| ไม่ถูกเรียกเลย | `description` ไม่มีคำที่ผู้ใช้พิมพ์จริง | `description` ใน `SKILL.md` ไม่ใช่เนื้อใน |
| ถูกเรียกในงานที่ไม่เกี่ยว | trigger กว้างไป หรือใช้คำกดดัน | ยุบ trigger ให้เหลือเคสที่ต่างกันจริง แล้วลดความแรงของคำ |
| จบทั้งที่ยังไม่เสร็จ | เงื่อนไขจบคลุมเครือ | บรรทัด **Done when** ของ step นั้นใน `figma-rename.md` |
| ทำสิ่งที่สั่งห้ามไว้ | คำสั่งห้ามทำให้พฤติกรรมนั้นเด่นขึ้น | เขียนใหม่ให้ขึ้นต้นด้วยสิ่งที่ *ควร* ทำ แล้วค่อยตามด้วยข้อยกเว้น |
| ไม่เคยเปิดไฟล์ใน `references/` | pointer เขียนอ่อน | แก้ถ้อยคำ pointer ก่อน อย่าเพิ่งดึงเนื้อหากลับมา inline |
| ข้ามขั้นตอนไปเลย | คำสั่งอยู่ลึกเกินกว่าจะถูกอ่าน | ย้ายขึ้น `SKILL.md` ซึ่งเป็นไฟล์เดียวที่ถูกอ่านแน่ ๆ |
| ยาวขึ้นเรื่อย ๆ แต่ไม่ดีขึ้น | ตะกอนสะสม จนส่วนสำคัญจม | ไล่ prune ใหม่ทั้งชุด — ดูหัวข้อถัดไป |

สองแถวล่างเจอกับ skill นี้จริงทั้งคู่ — ทางลัด MCP ตอน inventory และการข้ามคำถามเรื่อง
convention ทั้งสองครั้งคำแนะนำถูกต้องอยู่แล้ว แต่ลึกเกินไปสามไฟล์ **การแก้ที่ได้ผลคือย้าย
ขึ้นมา ไม่ใช่เขียนให้แรงขึ้น**
## ข้อจำกัดที่ยืนยันแล้ว

- **Plan ของทีมเป็น Organization ไม่ใช่ Enterprise** — REST Variables API ใช้ไม่ได้
  ทั้งอ่านและเขียน ทางที่ใช้ได้คือ MCP `use_figma` (Plugin API) ซึ่ง skill นี้ใช้อยู่
- **Library (remote) entity แก้จากไฟล์ที่ consume ไม่ได้** ต้องไปแก้ไฟล์ต้นทาง
- **`use_figma` เป็น atomic** — สคริปต์ที่ throw จะไม่ถูกรันเลย เลยออกแบบให้
  validate ทุก id ก่อน mutate ตัวแรก
- **codemod แตะได้เฉพาะข้อความตรง ๆ** ชื่อที่ประกอบขึ้นตอน runtime
  (`'--' + kind + '-' + variant`) หาไม่เจอ ต้อง grep เศษชื่อเอาเองหลัง batch
- **ทดสอบกับไฟล์ Figma จริงแล้ว** อ่าน 1,148 variable, rename 1 ตัว แล้ว reverse กลับ
  ตอน rename มี semantic token อ้างอยู่ 14 ตัว ไม่พังสักตัว — ยืนยันว่า Figma ผูกด้วย id จริง

---

## แก้ตัว skill

มีสองอย่างที่ต้องผ่าน และเป็นคนละเรื่องกัน:

```bash
node skills/figma-rename/scripts/selftest.mjs     # 174 เคส — สคริปต์ยังถูก
```

กับ **eval** ใน `skills/figma-rename/evals/` ซึ่งทดสอบว่า *agent เดินกระบวนการถูก* —
ถามเรื่อง convention ก่อนไหม ดึงค่ามาด้วยหรือเอาแค่ชื่อ หยุดให้คนอ่าน `needsReview` ไหม
regenerate ก่อน codemod ไหม ผ่าน selftest ไม่ได้แปลว่าผ่าน eval
วิธีรันกับวิธีให้คะแนนอยู่ใน [evals/README.md](../skills/figma-rename/evals/README.md)

จุดที่ต้องระวังเป็นพิเศษ:

**`lib/naming.mjs` ห้ามเพี้ยนจากของ `figma-token-export`** — codemod ต้องสะกด
identifier ให้ตรงกับที่ generator เขียนออกมาเป๊ะ ๆ `naming.lock.json` ล็อก hash ของทุกฟังก์ชันไว้
selftest เลยจับได้แม้อีก repo จะไม่ได้อยู่บนเครื่องเดียวกัน แก้แล้วต้อง `--relock`
**แล้วไปแก้ figma-token-export ให้ตรงกันด้วย**

**เพิ่ม preset ของทีม** — วางไฟล์ที่ `skills/figma-rename/presets/<ชื่อ>.json` โครงเหมือน
`aurora.json` แล้วโปรเจกต์อ้างด้วย `"extends": "<ชื่อ>"` ได้เลย ไม่ต้องแก้โค้ด
ถ้าจะต่อยอดจากของเดิม ให้ preset นั้น `extends` อีกอันได้ (ซ้อนได้) ไฟล์กลางที่ไม่ได้อยู่
ใน repo นี้อ้างด้วย path จากตัว config ได้เหมือนกัน

**ปรับลำดับกฎของ classifier** — อย่า fork `lib/classify.mjs` ให้ใส่ใน preset แทน:

```jsonc
"components": { "classifier": {
  "minConfidence": "medium",
  "priorities": { "Tooltip": 139 },      // ทับลำดับเดิมของกฎนั้น
  "disable": ["Radio Button"],           // ปิดกฎที่ให้ผลผิดกับไฟล์นี้
  "pageHints": { "Forms": ["Text Input", "Checkbox"] }
} }
```

กฎที่ลำดับสูงกว่าชนะ เวลาปรับให้ขยับทีละข้อแล้วรัน selftest — เคสในนั้นมาจาก
component จริงที่เคยถูกจัดผิด (ปุ่มกลายเป็น Tooltip, badge ตัวเลขกลายเป็น Radio Button)
ขยับแรงเกินไปจะพังเคสเหล่านั้นทันที

**เพิ่มการสะกดใหม่ในโค้ด** (เช่น Kotlin, Swift) — แก้ `lib/codemod.mjs`
ฟังก์ชัน `spellingsFor` + เพิ่ม guard ใน `GUARDS` แล้วเพิ่มชื่อใน
`VALID_SPELLINGS` ที่ `lib/config.mjs`

**เพิ่มหมวดตัวเลขใหม่** (เช่น z-index, duration) — แก้ `lib/suggest.mjs`:
เพิ่ม entry ใน `NAME_CATEGORY`, `SCOPE_CATEGORY` และตาราง semantic ของหมวดนั้น

**ปรับตารางสี** — `HUE_RANGES` / `SHADE_CHROMATIC` / `SHADE_NEUTRAL` ใน
`lib/suggest.mjs` แต่ก่อนแก้ ให้ดูก่อนว่า calibration แก้ปัญหาให้แล้วหรือยัง
(ตารางในตัวเป็นแค่ fallback ตอนไฟล์ไม่มี ramp ให้เรียน)

selftest ผูกกับ palette จริง ไม่ใช่ค่าที่แต่งขึ้น — Tailwind blue/gray ครบ 11 ขั้น
และ ramp production ที่ไม่ใช่ Tailwind รวมเคสที่ยืนยันว่า **ตารางในตัวพังเห็น ๆ**
กับ ramp นั้น เพื่อให้จับได้ถ้า calibration ถูกปิดไปเงียบ ๆ

---

## อ่านต่อ

- ทำไมมันทำงานแบบนั้น → [REFERENCE.md](REFERENCE.md)
- คู่มือฉบับเต็มที่ Claude อ่าน → `skills/figma-rename/figma-rename.md`
- สัญญาของ rename-map.json → `skills/figma-rename/references/rename-map.md`
