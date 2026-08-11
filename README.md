# figma-rename

Claude Code Skill สำหรับ **เปลี่ยนชื่อ token / component ใน Figma พร้อม sync ชื่อในโค้ดให้ตรงกัน**
ในการเปลี่ยนแปลงก้อนเดียวที่รีวิวได้และย้อนได้

```
Figma ──inventory──▶ rename-map.json ──┬──▶ use_figma     (แก้ชื่อใน Figma)
       (read-only)    (review + commit)  └──▶ codemod       (แก้ชื่อในโค้ดทุกที่)
```

ทั้งหมดตั้งอยู่บนความไม่สมมาตรข้อเดียว: **Figma ผูกด้วย id เปลี่ยนชื่อแล้วไม่พังอะไร
ส่วนโค้ดผูกด้วยชื่อ เปลี่ยนแล้วพังทุกที่ที่อ้างถึง** — ยืนยันกับไฟล์จริงแล้วว่า rename ตัวหนึ่ง
ที่มี semantic token อ้างอยู่ 14 ตัว ไม่กระทบสักตัวเดียว การ rename จึงเป็นงานที่ต้องลง
พร้อมกันสองฝั่ง ไม่ใช่งานใน Figma อย่างเดียว

`rename-map.json` คือสัญญากลาง — ทั้งสองฝั่ง derive จากรายการคู่ชื่อชุดเดียวกัน
เลยไม่มีทางที่ชื่อใน Figma กับในโค้ดจะเพี้ยนออกจากกัน

## อ่านไฟล์ไหนดี

| คุณคือ | อ่าน |
|---|---|
| อยากเปลี่ยนชื่อ token / component ทั้งชุด | [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) · [English](docs/GETTING-STARTED.en.md) |
| อยากรู้ว่าทำไมมันทำงานแบบนั้น | [docs/REFERENCE.md](docs/REFERENCE.md) · [English](docs/REFERENCE.en.md) |
| ต้องรันสคริปต์เอง / แก้ skill | [docs/MAINTAINING.md](docs/MAINTAINING.md) · [English](docs/MAINTAINING.en.md) |

## ติดตั้งลงโปรเจกต์

```bash
git clone git@github.com:charun-meedate/figma-rename.git ~/dev/figma-rename
cd ~/dev/figma-rename

./install.sh ~/dev/my-project           # copy เข้า .claude/skills/ ของโปรเจกต์
./install.sh ~/dev/my-project --link    # symlink แทน (อัปเดตตาม git pull อัตโนมัติ)
./install.sh --global                   # ลง ~/.claude/skills/ ใช้ได้ทุกโปรเจกต์
```

- **copy** — เหมาะกับโปรเจกต์ที่ commit `.claude/skills/` เข้า git ทุกคนในทีมได้เวอร์ชันเดียวกันแน่นอน
- **`--link`** — เหมาะกับเครื่องตัวเอง ได้ของใหม่ทันทีที่ `git pull` แต่คนอื่นใน repo ไม่ได้ไปด้วย
- **`--global`** — ใช้ได้ทุกโปรเจกต์บนเครื่องตัวเอง แต่ทีมไม่เห็น

เปิด Claude Code ในโปรเจกต์แล้วสั่งได้เลย skill จะถูกเรียกเอง:

> เปลี่ยนชื่อ token ในไฟล์นี้ให้ตรง convention หน่อย เริ่มจาก collection Primitive ก่อน
> https://www.figma.com/design/xxxx/DS

## โครงสร้าง

```
README.md                    ไฟล์นี้
install.sh                   ติดตั้ง skill เข้าโปรเจกต์
docs/                        เอกสารสำหรับคน — คนใช้ / ทำไมถึงทำงานแบบนั้น / คนดูแล
skills/figma-rename/         ตัว skill
├── SKILL.md                 ไฟล์ที่ Claude Code โหลด
├── figma-rename.md          คู่มือฉบับเต็ม
├── references/              รายละเอียดแยกหัวข้อ โหลดเมื่อจำเป็น
├── evals/                   ชุดทดสอบพฤติกรรม 4 อัน
└── scripts/                 โค้ดจริง ไม่มี dependency (Node 18+)
```

## เช็คว่าเครื่องพร้อม

```bash
node skills/figma-rename/scripts/selftest.mjs
```

รันสคริปต์จริงบนโปรเจกต์ชั่วคราวในโฟลเดอร์ temp ไม่แตะโปรเจกต์ไหน
ต้องขึ้น `64 passed, 0 failed`

สถานะการทดสอบทั้งหมดบันทึกไว้ที่เดียว ใน
[docs/REFERENCE.md → สถานะการทดสอบ](docs/REFERENCE.md#สถานะการทดสอบ)

## ใช้คู่กับ figma-token-export ได้ แต่ไม่ผูกกัน

ขั้น regenerate เรียก `sync.mjs` ของ
[figma-token-export](https://github.com/charun-meedate/figma-token-export) ถ้ามี
ถ้าโปรเจกต์ไม่ได้ใช้ ก็ข้ามขั้นนั้นไปแล้วให้ codemod ครอบคลุมทั้งหมดแทน

**จุดเดียวที่ผูกกันจริงคือ `scripts/lib/naming.mjs`** ซึ่ง copy ไว้ทั้งสอง repo โดยตั้งใจ —
codemod ต้องสะกด identifier ให้ตรงกับที่ generator เขียนออกมาเป๊ะ ๆ ถ้าเพี้ยนกันเมื่อไหร่
codemod จะไปเปลี่ยนชื่อเป็นสิ่งที่ไม่มีใคร generate `naming.lock.json` ล็อกทุกฟังก์ชันไว้
selftest เลยจับได้แม้อีก repo จะไม่ได้อยู่บนเครื่องเดียวกัน **แก้ที่หนึ่งต้องแก้อีกที่**

## ข้อจำกัดที่ต้องรู้

Plan ของทีมเป็น **Organization** ไม่ใช่ Enterprise — REST Variables API ใช้ไม่ได้
ทั้งอ่านและเขียน ทางที่ใช้จริงคือ MCP `use_figma` (Plugin API) ซึ่ง skill นี้ใช้อยู่
ข้อจำกัดที่เหลืออยู่ท้าย [docs/MAINTAINING.md](docs/MAINTAINING.md)

## แก้ skill

รัน `selftest.mjs` (สคริปต์ยังถูก) **และ** eval ใน `skills/figma-rename/evals/`
(agent ยังเดินกระบวนการถูก) — คนละเรื่องกัน ทั้งสองอย่างต้องผ่าน

```bash
node skills/figma-rename/scripts/selftest.mjs
```

ถ้าแตะ `lib/naming.mjs` ต้อง re-lock ด้วย
`node skills/figma-rename/scripts/selftest.mjs --relock` **แล้วไปแก้ figma-token-export
ให้ตรงกันด้วย** ไม่งั้น codemod กับ generator จะสะกดคนละแบบ
