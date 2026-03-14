---
name: C2E Map Generation Prompts
overview: Create a markdown document containing ready-to-use prompts for image generator LLMs (DALL-E, Midjourney, Stable Diffusion, etc.) to produce vicinity and site layout maps for the C2E Bombing scenario, with a consistent label scheme for citing decisions.
todos: []
isProject: false
---

# C2E Map Generation Prompts Document

## Goal

Create [docs/C2E_MAP_GENERATION_PROMPTS.md](docs/C2E_MAP_GENERATION_PROMPTS.md) with prompts for image generator LLMs to produce two map types for the C2E Bombing at Community Event scenario:

1. **Vicinity map** – wider surroundings (~2 km radius): blast site, hospitals, police, CCTV, emergency routes
2. **Site layout map** – close-up of the hard court: blast site, exits, site areas, cordon

All elements must use **consistent labels** (e.g. `N`, `S`, `north_side`, `gz`) so teams can cite them in decisions and the AI can cross-reference with `insider_knowledge`.

---

## Document Structure

### 1. Introduction and purpose

- Brief purpose: prompts for DALL-E, Midjourney, Stable Diffusion, or similar image generators
- Scenario: C2E Bombing at Community Event (neighbourhood hard court, Singapore)
- Two map types and when to use each

### 2. Label reference table

A table mapping all label IDs to human-readable names for citation. Align with [migrations/061_c2e_detailed_insider_knowledge.sql](migrations/061_c2e_detailed_insider_knowledge.sql):

| Category   | Label ID                                                      | Display name                                                 | Citation example            |
| ---------- | ------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------- |
| Exits      | N, S, E, W, CC                                                | North exit, South exit, East exit, West exit, Community club | "evacuate via N"            |
| Zones      | gz, cordon                                                    | Ground zero, Inner cordon                                    | "assembly 30 m from cordon" |
| Site areas | north_side, south_side, east_strip, west_area, adjacent_field | North side of court, etc.                                    | "triage at north_side"      |
| Vicinity   | TTSH, BCH, TPP, BNNPC, TPENPC, AMKDHQ                         | Hospital/police names                                        | "route to TTSH"             |

### 3. Vicinity map prompt

A single, detailed prompt that produces a **vicinity map** (~2 km radius) with:

- **Centre:** Hard court / blast site (labelled `BLAST_SITE`)
- **Hospitals:** Tan Tock Seng Hospital (TTSH), Bishan Community Hospital (BCH), Toa Payoh Polyclinic (TPP) – with labels
- **Police:** Bishan North NPC (BNNPC), Toa Payoh East NPC (TPENPC), Ang Mo Kio Division HQ (AMKDHQ) – with labels
- **CCTV points:** Main gate (N), Community club lobby (E), Multi-storey carpark rooftop, Bus interchange – with labels
- **Emergency routes:** Bishan Street 13 (north), Lorong 2 Toa Payoh (east), Service road (west)
- **Style:** Clean tactical diagram, top-down or isometric, readable labels, no clutter

Include:

- Exact prompt text (copy-paste ready)
- Optional style modifiers (e.g. "aerial view", "tactical overlay")
- Aspect ratio recommendation (e.g. 16:9 or 4:3)

### 4. Site layout map prompt

A single, detailed prompt that produces a **site layout map** (close-up of the hard court) with:

- **Blast site:** Stage/sound system at north end, debris radius ~15 m, labelled `GZ` (ground zero)
- **Inner cordon:** 20 m ring, labelled `CORDON`
- **Exits:** N (main gate, north), S (south to playground), E (east beside club), W (west, service road), CC (community club indoor route) – each with label
- **Site areas:** north_side, south_side, east_strip, west_area, adjacent_field – each with label and brief descriptor (e.g. "north_side – covered shelter")
- **Features:** Food stalls (east), carpark (north), community club (east), HDB blocks (south)
- **Style:** Floor-plan style, clear boundaries, readable labels

Include:

- Exact prompt text (copy-paste ready)
- Optional style modifiers
- Aspect ratio recommendation

### 5. Prompt variants (optional)

Short variants for different generators:

- **DALL-E 3:** More literal, structured; may need to emphasise "labelled diagram"
- **Midjourney:** Style tags (e.g. `--style raw`, `--v 6`) for diagram-like output
- **Stable Diffusion:** May need ControlNet or img2img for precise labels; note limitations

### 6. Implementation notes

- How to use: copy prompt into image generator; optionally iterate on style
- After generation: upload to Supabase Storage, set `vicinity_map_url` / `layout_image_url` on scenario
- Reference: [docs/SCENARIO_VICINITY_MAP_AND_LAYOUT.md](docs/SCENARIO_VICINITY_MAP_AND_LAYOUT.md) for storage and display flow

### 7. Data source reference

- Layout and labels derived from [migrations/061_c2e_detailed_insider_knowledge.sql](migrations/061_c2e_detailed_insider_knowledge.sql)
- [docs/C2E_INSIDER_INTEL_REFERENCE.md](docs/C2E_INSIDER_INTEL_REFERENCE.md) for intel categories

---

## Key labels to include (from migration 061)

**Exits:** N, S, E, W, CC  
**Zones:** gz (ground zero), cordon (inner cordon)  
**Site areas:** north_side, south_side, east_strip, west_area, adjacent_field  
**Vicinity POIs:** TTSH, BCH, TPP (hospitals); BNNPC, TPENPC, AMKDHQ (police); CCTV_N, CCTV_E, CCTV_CARPARK, CCTV_BUS (CCTV)

---

## File location

`docs/C2E_MAP_GENERATION_PROMPTS.md`
