/** Evaluate a Postgres CHECK body against a row. Promotion and U4 share this with the database. */

type Value = string | number | boolean | null | unknown[] | Record<string, unknown>;

interface Token {
  kind: string;
  text: string;
}

export function tokenise(body: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const push = (kind: string, text: string) => tokens.push({ kind, text });
  while (index < body.length) {
    const char = body[index] ?? '';
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "'") {
      let text = '';
      index += 1;
      while (index < body.length) {
        if (body[index] === "'" && body[index + 1] === "'") {
          text += "'";
          index += 2;
          continue;
        }
        if (body[index] === "'") {
          index += 1;
          break;
        }
        text += body[index];
        index += 1;
      }
      if (text === '{}' && /^::[A-Za-z_][A-Za-z0-9_]*\[\]/.test(body.slice(index))) {
        push('ident', 'array');
        push('punct', '[');
        push('punct', ']');
        index = skipCast(body, index);
        continue;
      }
      push('string', text);
      continue;
    }
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(body[index + 1] ?? ''))) {
      const match = /^[0-9]+(\.[0-9]+)?/.exec(body.slice(index));
      push('number', match?.[0] ?? '0');
      index += match?.[0].length ?? 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(index));
      push('ident', (match?.[0] ?? '').toLowerCase());
      index += match?.[0].length ?? 1;
      continue;
    }
    const two = body.slice(index, index + 2);
    if (two === '::') {
      index = skipCast(body, index);
      continue;
    }
    if (['>=', '<=', '<>', '!='].includes(two)) {
      push('op', two);
      index += 2;
      continue;
    }
    if ('=<>~(),[]'.includes(char) || char === '@') {
      if (char === '<' && body[index + 1] === '@') {
        push('op', '<@');
        index += 2;
        continue;
      }
      push(char === '~' || char === '=' || char === '<' || char === '>' ? 'op' : 'punct', char);
      index += 1;
      continue;
    }
    throw new Error(`cannot tokenise CHECK near ${body.slice(index, index + 20)}`);
  }
  return tokens;
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly row: Record<string, unknown> = {},
  ) {}

  static eval(tokens: Token[], row: Record<string, unknown>): unknown {
    const parser = new Parser(tokens, row);
    const value = parser.parseOr();
    parser.end();
    return value;
  }

  end(): void {
    if (this.index < this.tokens.length) {
      throw new Error(`leftover CHECK token ${this.tokens[this.index]?.text ?? ''}`);
    }
  }

  parseOr(): unknown {
    let left = this.parseAnd();
    while (this.matchIdent('or')) {
      const right = this.parseAnd();
      left =
        left === true || right === true ? true : left === false && right === false ? false : null;
    }
    return left;
  }

  parseAnd(): unknown {
    let left = this.parseNot();
    while (this.matchIdent('and')) {
      const right = this.parseNot();
      left =
        left === false || right === false ? false : left === true && right === true ? true : null;
    }
    return left;
  }

  parseNot(): unknown {
    if (this.matchIdent('not')) {
      const value = this.parseNot();
      return value === null ? null : !value;
    }
    return this.parseCompare();
  }

  parseCompare(): unknown {
    const left = this.parseUnary();
    if (this.matchIdent('is')) {
      const not = this.matchIdent('not');
      this.expectIdent('null');
      const isNull = left === null;
      return not ? !isNull : isNull;
    }
    const op = this.peek()?.kind === 'op' ? this.tokens[this.index] : undefined;
    if (!op) return left;
    this.index += 1;
    if (op.text === '~') {
      const right = this.parseUnary();
      if (left === null || right === null) return null;
      return new RegExp(String(right)).test(String(left));
    }
    if (op.text === '<@') {
      const right = this.parseUnary();
      if (!Array.isArray(left) || !Array.isArray(right)) return null;
      return left.every((item) => right.includes(item));
    }
    if (this.matchIdent('any')) {
      this.matchPunct('(');
      const list = this.parseArray();
      this.matchPunct(')');
      if (left === null) return null;
      return list.some(
        (item) =>
          item === left || (num(item) !== null && num(left) !== null && num(item) === num(left)),
      );
    }
    const right = this.parseUnary();
    if (left === null || right === null) return null;
    const a = num(left);
    const b = num(right);
    if (op.text === '=') return same(left, right);
    if (op.text === '<>' || op.text === '!=') return !same(left, right);
    if (a === null || b === null) return false;
    if (op.text === '>') return a > b;
    if (op.text === '>=') return a >= b;
    if (op.text === '<') return a < b;
    if (op.text === '<=') return a <= b;
    throw new Error(`unknown operator ${op.text}`);
  }

  parseUnary(): unknown {
    if (this.matchPunct('(')) {
      const value = this.parseOr();
      this.expectPunct(')');
      return value;
    }
    if (this.peek()?.kind === 'ident') {
      const name = this.tokens[this.index]?.text ?? '';
      if (
        [
          'char_length',
          'cardinality',
          'jsonb_typeof',
          'jsonb_array_length',
          'octet_length',
          'lower',
        ].includes(name)
      ) {
        this.index += 1;
        this.expectPunct('(');
        const arg = this.parseOr();
        this.expectPunct(')');
        return call(name, arg);
      }
    }
    return this.parsePrimary();
  }

  parsePrimary(): unknown {
    const token = this.tokens[this.index];
    if (!token) throw new Error('CHECK ended early');
    this.index += 1;
    if (token.kind === 'string') return token.text;
    if (token.kind === 'number') return Number(token.text);
    if (token.kind === 'ident' && token.text === 'null') return null;
    if (token.kind === 'ident' && token.text === 'true') return true;
    if (token.kind === 'ident' && token.text === 'false') return false;
    if (token.kind === 'ident' && token.text === 'array') return this.parseArray();
    if (token.kind === 'punct' && token.text === '[') {
      this.index -= 1;
      return this.parseArray();
    }
    if (token.kind === 'ident') return (this.row[token.text] ?? null) as Value;
    throw new Error(`unexpected CHECK token ${token.text}`);
  }

  parseArray(): unknown[] {
    if (this.matchIdent('array')) {
      /* ARRAY[ ... ] */
    }
    this.expectPunct('[');
    const values: unknown[] = [];
    if (!this.matchPunct(']')) {
      values.push(this.parseOr());
      while (this.matchPunct(',')) values.push(this.parseOr());
      this.expectPunct(']');
    }
    return values;
  }

  matchIdent(text: string): boolean {
    if (this.peek()?.kind === 'ident' && this.peek()?.text === text) {
      this.index += 1;
      return true;
    }
    return false;
  }

  expectIdent(text: string): void {
    if (!this.matchIdent(text)) throw new Error(`expected ${text}`);
  }

  matchPunct(text: string): boolean {
    if (this.peek()?.kind === 'punct' && this.peek()?.text === text) {
      this.index += 1;
      return true;
    }
    return false;
  }

  expectPunct(text: string): void {
    if (!this.matchPunct(text)) throw new Error(`expected ${text}`);
  }

  peek(): Token | undefined {
    return this.tokens[this.index];
  }
}

function call(name: string, arg: unknown): unknown {
  if (arg === null) return null;
  if (name === 'char_length') return String(arg).length;
  if (name === 'lower') return String(arg).toLowerCase();
  if (name === 'cardinality' || name === 'jsonb_array_length')
    return Array.isArray(arg) ? arg.length : null;
  if (name === 'jsonb_typeof') {
    if (Array.isArray(arg)) return 'array';
    if (typeof arg === 'object') return 'object';
    return typeof arg;
  }
  if (name === 'octet_length') return Buffer.byteLength(JSON.stringify(arg));
  return null;
}

function same(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => same(item, right[index]));
  }
  const a = num(left);
  const b = num(right);
  return left === right || (a !== null && b !== null && a === b);
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return null;
}

function skipCast(body: string, index: number): number {
  let cursor = index + 2;
  let words = 0;
  while (cursor < body.length) {
    while (cursor < body.length && /\s/.test(body[cursor] ?? '')) cursor += 1;
    const typeName = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(cursor));
    if (typeName && (words === 0 || typeName[0] === 'precision')) {
      cursor += typeName[0].length;
      words += 1;
      continue;
    }
    if (body.slice(cursor, cursor + 2) === '[]') {
      cursor += 2;
      continue;
    }
    break;
  }
  return cursor;
}

export function evaluateCheck(body: string, row: Record<string, unknown>): boolean {
  const tokens = tokenise(body);
  return Parser.eval(tokens, row) === true;
}

/** CHECK bodies of the typed knowledge tables, taken from the applied migrations. */
export interface KnowledgeCheck {
  table: string;
  name: string;
  body: string;
}

export const KNOWLEDGE_CHECKS: KnowledgeCheck[] = [
  {
    table: 'doctrine_versions',
    name: 'doctrine_versions_content_bytes_check',
    body: '((content_bytes >= 2) AND (content_bytes <= 24576))',
  },
  {
    table: 'doctrine_versions',
    name: 'doctrine_versions_content_check',
    body: "(jsonb_typeof(content) = 'object'::text)",
  },
  {
    table: 'doctrine_versions',
    name: 'doctrine_versions_content_hash_check',
    body: "(content_hash ~ '^[0-9a-f]{64}$'::text)",
  },
  {
    table: 'doctrine_versions',
    name: 'doctrine_versions_review_note_check',
    body: '((review_note IS NULL) OR (char_length(review_note) <= 1000))',
  },
  {
    table: 'doctrine_versions',
    name: 'doctrine_versions_review_pair',
    body: "((review_status = 'unverified'::text) OR (reviewed_at IS NOT NULL))",
  },
  {
    table: 'doctrine_versions',
    name: 'doctrine_versions_review_status_check',
    body: "(review_status = ANY (ARRAY['unverified'::text, 'verified'::text]))",
  },
  {
    table: 'doctrine_versions',
    name: 'doctrine_versions_schema_version_check',
    body: '(schema_version = 1)',
  },
  {
    table: 'doctrine_versions',
    name: 'doctrine_versions_screen_flags_known',
    body: "(screen_flags <@ ARRAY['instruction_like'::text, 'markup_removed'::text, 'link_removed'::text, 'contact_details'::text, 'device_wording'::text])",
  },
  {
    table: 'doctrine_versions',
    name: 'doctrine_versions_source_document_sha256_check',
    body: "((source_document_sha256 IS NULL) OR (source_document_sha256 ~ '^[0-9a-f]{64}$'::text))",
  },
  {
    table: 'doctrine_versions',
    name: 'doctrine_versions_source_note_check',
    body: '((source_note IS NULL) OR (char_length(source_note) <= 300))',
  },
  {
    table: 'doctrine_versions',
    name: 'doctrine_versions_title_check',
    body: '((char_length(title) >= 3) AND (char_length(title) <= 120))',
  },
  {
    table: 'doctrine_versions',
    name: 'doctrine_versions_version_check',
    body: '(version >= 1)',
  },
  {
    table: 'doctrines',
    name: 'doctrines_agency_name_check',
    body: '((agency_name IS NULL) OR ((char_length(agency_name) >= 2) AND (char_length(agency_name) <= 120)))',
  },
  {
    table: 'doctrines',
    name: 'doctrines_applies_to_known',
    body: "(applies_to <@ ARRAY['bombing'::text, 'car_bomb'::text, 'suicide_bombing'::text, 'bombing_mall'::text, 'open_field_shooting'::text, 'knife_attack'::text, 'gas_attack'::text, 'poisoning'::text, 'kidnapping'::text, 'hijacking'::text, 'building_fire'::text, 'utility_failure'::text, 'arson'::text, 'stampede_crush'::text, 'vehicle_ramming'::text, 'aircraft_impact'::text, 'gas_explosion'::text, 'chemical_release'::text, 'structural_collapse'::text, 'rail_incident'::text, 'road_collision'::text, 'flash_flood'::text, 'biohazard'::text, 'maritime_incident'::text, 'earthquake'::text, 'active_shooter'::text])",
  },
  {
    table: 'doctrines',
    name: 'doctrines_country_check',
    body: "((country IS NULL) OR (country ~ '^[A-Z]{2}$'::text))",
  },
  {
    table: 'doctrines',
    name: 'doctrines_establishment_type_check',
    body: "((establishment_type IS NULL) OR (establishment_type = ANY (ARRAY['private_security'::text, 'auxiliary_police'::text, 'establishment_ert'::text, 'venue_operations'::text])))",
  },
  {
    table: 'doctrines',
    name: 'doctrines_latest_verified_version_check',
    body: '((latest_verified_version IS NULL) OR (latest_verified_version >= 1))',
  },
  {
    table: 'doctrines',
    name: 'doctrines_latest_version_check',
    body: '(latest_version >= 1)',
  },
  {
    table: 'doctrines',
    name: 'doctrines_organisation_scope',
    body: "(((visibility = 'organisation'::text) = (source = 'custom'::text)) AND ((visibility <> 'organisation'::text) OR ((owner_id IS NOT NULL) AND (establishment_type IS NOT NULL))))",
  },
  {
    table: 'doctrines',
    name: 'doctrines_parent_version_check',
    body: '((parent_version IS NULL) OR (parent_version >= 1))',
  },
  {
    table: 'doctrines',
    name: 'doctrines_parent_version_needs_parent',
    body: '((parent_doctrine_id IS NULL) OR (parent_version IS NOT NULL))',
  },
  {
    table: 'doctrines',
    name: 'doctrines_retired_reason_check',
    body: '((retired_reason IS NULL) OR (char_length(retired_reason) <= 500))',
  },
  {
    table: 'doctrines',
    name: 'doctrines_source_check',
    body: "(source = ANY (ARRAY['seeded'::text, 'trainer'::text, 'ai_drafted'::text, 'imported'::text, 'custom'::text]))",
  },
  {
    table: 'doctrines',
    name: 'doctrines_title_check',
    body: '((char_length(title) >= 3) AND (char_length(title) <= 120))',
  },
  {
    table: 'doctrines',
    name: 'doctrines_venue_scope_check',
    body: "((venue_scope IS NULL) OR (jsonb_typeof(venue_scope) = 'object'::text))",
  },
  {
    table: 'doctrines',
    name: 'doctrines_verified_not_after_latest',
    body: '((latest_verified_version IS NULL) OR (latest_verified_version <= latest_version))',
  },
  {
    table: 'doctrines',
    name: 'doctrines_visibility_check',
    body: "(visibility = ANY (ARRAY['library'::text, 'private'::text, 'organisation'::text]))",
  },
  {
    table: 'fieldops_building_items',
    name: 'fieldops_building_items_likelihood_permille_check',
    body: '((likelihood_permille >= 0) AND (likelihood_permille <= 1000))',
  },
  {
    table: 'fieldops_building_items',
    name: 'fieldops_building_items_location_kind_check',
    body: "(location_kind = ANY (ARRAY['basement'::text, 'ground'::text, 'roof'::text, 'plant_room'::text, 'kitchen'::text, 'loading_bay'::text, 'car_park'::text, 'retail_floor'::text, 'office_floor'::text, 'process_area'::text, 'tank_farm'::text, 'store'::text, 'laboratory'::text, 'external_yard'::text, 'any'::text]))",
  },
  {
    table: 'fieldops_building_items',
    name: 'fieldops_building_items_quantity_band_check',
    body: "(quantity_band = ANY (ARRAY['small'::text, 'medium'::text, 'large'::text, 'category_only'::text]))",
  },
  {
    table: 'fieldops_building_items',
    name: 'fieldops_building_items_quantity_unit_check',
    body: "((quantity_unit IS NULL) OR (quantity_unit = ANY (ARRAY['kg'::text, 'l'::text, 'm3'::text, 'count'::text, 'kwh'::text, 'kva'::text])))",
  },
  {
    table: 'fieldops_building_items',
    name: 'fieldops_building_items_quantity',
    body: "(((quantity_band = 'category_only'::text) AND (quantity_low IS NULL) AND (quantity_high IS NULL) AND (quantity_unit IS NULL)) OR ((quantity_band <> 'category_only'::text) AND (quantity_low IS NOT NULL) AND (quantity_high IS NOT NULL) AND (quantity_unit IS NOT NULL) AND (quantity_low <= quantity_high)))",
  },
  {
    table: 'fieldops_building_items',
    name: 'fieldops_building_items_row_version_check',
    body: '(row_version >= 1)',
  },
  {
    table: 'fieldops_building_items',
    name: 'fieldops_building_items_source_note_check',
    body: '((char_length(source_note) >= 3) AND (char_length(source_note) <= 400))',
  },
  {
    table: 'fieldops_building_items',
    name: 'fieldops_building_items_source_ref_check',
    body: '((char_length(source_ref) >= 3) AND (char_length(source_ref) <= 300))',
  },
  {
    table: 'fieldops_building_items',
    name: 'fieldops_building_items_status_check',
    body: "(status = ANY (ARRAY['active'::text, 'retired'::text]))",
  },
  {
    table: 'fieldops_building_types',
    name: 'fieldops_building_types_basement_storey_height_m_check',
    body: '((basement_storey_height_m >= 2.4) AND (basement_storey_height_m <= (8)::numeric))',
  },
  {
    table: 'fieldops_building_types',
    name: 'fieldops_building_types_country_check',
    body: "((country IS NULL) OR (country ~ '^[A-Z]{2}$'::text))",
  },
  {
    table: 'fieldops_building_types',
    name: 'fieldops_building_types_external_spread_permille_check',
    body: '((external_spread_permille >= 0) AND (external_spread_permille <= 1000))',
  },
  {
    table: 'fieldops_building_types',
    name: 'fieldops_building_types_facade_class_check',
    body: "(facade_class = ANY (ARRAY['curtain_wall_glass'::text, 'masonry'::text, 'concrete_panel'::text, 'metal_cladding'::text, 'open'::text]))",
  },
  {
    table: 'fieldops_building_types',
    name: 'fieldops_building_types_familiarity_check',
    body: "(familiarity = ANY (ARRAY['familiar'::text, 'mixed'::text, 'unfamiliar'::text]))",
  },
  {
    table: 'fieldops_building_types',
    name: 'fieldops_building_types_label_check',
    body: '((char_length(label) >= 1) AND (char_length(label) <= 80))',
  },
  {
    table: 'fieldops_building_types',
    name: 'fieldops_building_types_occupancy_by_hour_check',
    body: '(cardinality(occupancy_by_hour) = ANY (ARRAY[0, 48]))',
  },
  {
    table: 'fieldops_building_types',
    name: 'fieldops_building_types_occupant_m2_per_person_check',
    body: '((occupant_m2_per_person IS NULL) OR ((occupant_m2_per_person >= 0.3) AND (occupant_m2_per_person <= (200)::numeric)))',
  },
  {
    table: 'fieldops_building_types',
    name: 'fieldops_building_types_priority_check',
    body: '((priority >= 1) AND (priority <= 1000))',
  },
  {
    table: 'fieldops_building_types',
    name: 'fieldops_building_types_row_version_check',
    body: '(row_version >= 1)',
  },
  {
    table: 'fieldops_building_types',
    name: 'fieldops_building_types_sensitivity_check',
    body: "(sensitivity = ANY (ARRAY['public'::text, 'restricted_generic'::text]))",
  },
  {
    table: 'fieldops_building_types',
    name: 'fieldops_building_types_source_note_check',
    body: '((char_length(source_note) >= 3) AND (char_length(source_note) <= 400))',
  },
  {
    table: 'fieldops_building_types',
    name: 'fieldops_building_types_source_ref_check',
    body: '((char_length(source_ref) >= 3) AND (char_length(source_ref) <= 300))',
  },
  {
    table: 'fieldops_building_types',
    name: 'fieldops_building_types_sprinklered_permille_check',
    body: '((sprinklered_permille >= 0) AND (sprinklered_permille <= 1000))',
  },
  {
    table: 'fieldops_building_types',
    name: 'fieldops_building_types_status_check',
    body: "(status = ANY (ARRAY['active'::text, 'retired'::text]))",
  },
  {
    table: 'fieldops_building_types',
    name: 'fieldops_building_types_storey_height_m_check',
    body: '((storey_height_m >= 2.4) AND (storey_height_m <= (12)::numeric))',
  },
  {
    table: 'fieldops_building_types',
    name: 'fieldops_building_types_type_key_check',
    body: "(type_key ~ '^[a-z][a-z0-9_]{1,47}$'::text)",
  },
  {
    table: 'fieldops_capacity_aggregates',
    name: 'fieldops_capacity_aggregates_aggregate_key_check',
    body: "(aggregate_key ~ '^[a-z][a-z0-9_]{1,63}$'::text)",
  },
  {
    table: 'fieldops_capacity_aggregates',
    name: 'fieldops_capacity_aggregates_country_check',
    body: "(country ~ '^[A-Z]{2}$'::text)",
  },
  {
    table: 'fieldops_capacity_aggregates',
    name: 'fieldops_capacity_aggregates_label_check',
    body: '((char_length(label) >= 1) AND (char_length(label) <= 160))',
  },
  {
    table: 'fieldops_capacity_aggregates',
    name: 'fieldops_capacity_aggregates_source_note_check',
    body: '((char_length(source_note) >= 3) AND (char_length(source_note) <= 400))',
  },
  {
    table: 'fieldops_capacity_aggregates',
    name: 'fieldops_capacity_aggregates_source_ref_check',
    body: '((char_length(source_ref) >= 3) AND (char_length(source_ref) <= 300))',
  },
  {
    table: 'fieldops_capacity_aggregates',
    name: 'fieldops_capacity_aggregates_stated_values_check',
    body: "(jsonb_typeof(stated_values) = 'array'::text)",
  },
  {
    table: 'fieldops_capacity_aggregates',
    name: 'fieldops_capacity_aggregates_status_check',
    body: "(status = ANY (ARRAY['active'::text, 'retired'::text]))",
  },
  {
    table: 'fieldops_equipment',
    name: 'fieldops_equipment_capacity_check',
    body: '(capacity >= (0)::numeric)',
  },
  {
    table: 'fieldops_equipment',
    name: 'fieldops_equipment_category_check',
    body: "(category = ANY (ARRAY['water_tank'::text, 'pump'::text, 'hose'::text, 'foam'::text, 'breathing_apparatus'::text, 'ladder'::text, 'aerial_platform'::text, 'stretcher'::text, 'patient_capacity'::text, 'decontamination'::text, 'cutting'::text, 'thermal_camera'::text, 'gas_detector'::text, 'lighting'::text, 'barrier'::text, 'shoring'::text]))",
  },
  {
    table: 'fieldops_equipment',
    name: 'fieldops_equipment_equipment_key_check',
    body: "(equipment_key ~ '^[a-z][a-z0-9_]{1,47}$'::text)",
  },
  {
    table: 'fieldops_equipment',
    name: 'fieldops_equipment_label_check',
    body: '((char_length(label) >= 1) AND (char_length(label) <= 80))',
  },
  {
    table: 'fieldops_equipment',
    name: 'fieldops_equipment_source_note_check',
    body: '((char_length(source_note) >= 3) AND (char_length(source_note) <= 400))',
  },
  {
    table: 'fieldops_equipment',
    name: 'fieldops_equipment_source_ref_check',
    body: '((char_length(source_ref) >= 3) AND (char_length(source_ref) <= 300))',
  },
  {
    table: 'fieldops_equipment',
    name: 'fieldops_equipment_status_check',
    body: "(status = ANY (ARRAY['active'::text, 'retired'::text]))",
  },
  {
    table: 'fieldops_equipment',
    name: 'fieldops_equipment_unit_check',
    body: "(unit = ANY (ARRAY['l'::text, 'l_min'::text, 'm'::text, 's'::text, 'count'::text, 'p_h'::text, 'm2'::text]))",
  },
  {
    table: 'fieldops_explosive_materials',
    name: 'fieldops_explosive_materials_aliases_check',
    body: '(cardinality(aliases) <= 20)',
  },
  {
    table: 'fieldops_explosive_materials',
    name: 'fieldops_explosive_materials_confidence_check',
    body: "(confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text]))",
  },
  {
    table: 'fieldops_explosive_materials',
    name: 'fieldops_explosive_materials_label_check',
    body: '((char_length(label) >= 2) AND (char_length(label) <= 80))',
  },
  {
    table: 'fieldops_explosive_materials',
    name: 'fieldops_explosive_materials_material_key_check',
    body: "(material_key ~ '^[a-z][a-z0-9_]{1,39}$'::text)",
  },
  {
    table: 'fieldops_explosive_materials',
    name: 'fieldops_explosive_materials_review_state_check',
    body: "(review_state = ANY (ARRAY['unreviewed'::text, 'reviewed'::text]))",
  },
  {
    table: 'fieldops_explosive_materials',
    name: 'fieldops_explosive_materials_sort_order_check',
    body: '((sort_order >= 0) AND (sort_order <= 10000))',
  },
  {
    table: 'fieldops_explosive_materials',
    name: 'fieldops_explosive_materials_source_ref_check',
    body: '((char_length(source_ref) >= 3) AND (char_length(source_ref) <= 500))',
  },
  {
    table: 'fieldops_explosive_materials',
    name: 'fieldops_explosive_materials_status_check',
    body: "(status = ANY (ARRAY['active'::text, 'retired'::text]))",
  },
  {
    table: 'fieldops_explosive_materials',
    name: 'fieldops_explosive_materials_tnt_eq_impulse_check',
    body: '((tnt_eq_impulse >= 0.1) AND (tnt_eq_impulse <= 2.5))',
  },
  {
    table: 'fieldops_explosive_materials',
    name: 'fieldops_explosive_materials_tnt_eq_pressure_check',
    body: '((tnt_eq_pressure >= 0.1) AND (tnt_eq_pressure <= 2.5))',
  },
  {
    table: 'fieldops_explosive_materials',
    name: 'fieldops_explosive_materials_version_check',
    body: '(version >= 1)',
  },
  {
    table: 'fieldops_hazard_interactions',
    name: 'fieldops_hazard_interactions_agent_key_check',
    body: "((agent_key IS NULL) OR (agent_key ~ '^[a-z][a-z0-9_]{1,47}$'::text))",
  },
  {
    table: 'fieldops_hazard_interactions',
    name: 'fieldops_hazard_interactions_delay_high_s_check',
    body: '((delay_high_s >= 0) AND (delay_high_s <= 3600))',
  },
  {
    table: 'fieldops_hazard_interactions',
    name: 'fieldops_hazard_interactions_delay_low_s_check',
    body: '((delay_low_s >= 0) AND (delay_low_s <= 3600))',
  },
  {
    table: 'fieldops_hazard_interactions',
    name: 'fieldops_hazard_interactions_delay',
    body: '(delay_low_s <= delay_high_s)',
  },
  {
    table: 'fieldops_hazard_interactions',
    name: 'fieldops_hazard_interactions_effect_check',
    body: "(effect = ANY (ARRAY['rupture_release'::text, 'ignite'::text, 'pool_fire'::text, 'jet_fire'::text, 'flash_fire'::text, 'vapour_cloud_ignition'::text, 'vessel_burst'::text, 'fireball'::text, 'toxic_combustion_products'::text, 'electrical_arc'::text, 'thermal_runaway'::text, 'oxygen_enrichment'::text, 'loss_of_function'::text, 'activate'::text, 'power_loss'::text, 'collapse_local'::text]))",
  },
  {
    table: 'fieldops_hazard_interactions',
    name: 'fieldops_hazard_interactions_event_text_check',
    body: '((char_length(event_text) >= 3) AND (char_length(event_text) <= 200))',
  },
  {
    table: 'fieldops_hazard_interactions',
    name: 'fieldops_hazard_interactions_probability_permille_check',
    body: '((probability_permille >= 0) AND (probability_permille <= 1000))',
  },
  {
    table: 'fieldops_hazard_interactions',
    name: 'fieldops_hazard_interactions_release',
    body: "((effect <> 'rupture_release'::text) OR (agent_key IS NOT NULL))",
  },
  {
    table: 'fieldops_hazard_interactions',
    name: 'fieldops_hazard_interactions_row_version_check',
    body: '(row_version >= 1)',
  },
  {
    table: 'fieldops_hazard_interactions',
    name: 'fieldops_hazard_interactions_rule_key_check',
    body: "(rule_key ~ '^[a-z][a-z0-9_]{1,63}$'::text)",
  },
  {
    table: 'fieldops_hazard_interactions',
    name: 'fieldops_hazard_interactions_source_note_check',
    body: '((char_length(source_note) >= 3) AND (char_length(source_note) <= 400))',
  },
  {
    table: 'fieldops_hazard_interactions',
    name: 'fieldops_hazard_interactions_source_ref_check',
    body: '((char_length(source_ref) >= 3) AND (char_length(source_ref) <= 300))',
  },
  {
    table: 'fieldops_hazard_interactions',
    name: 'fieldops_hazard_interactions_status_check',
    body: "(status = ANY (ARRAY['active'::text, 'retired'::text]))",
  },
  {
    table: 'fieldops_hazard_interactions',
    name: 'fieldops_hazard_interactions_threat_key_check',
    body: "((threat_key IS NULL) OR (threat_key ~ '^[a-z][a-z0-9_]{1,47}$'::text))",
  },
  {
    table: 'fieldops_hazard_interactions',
    name: 'fieldops_hazard_interactions_trigger_check',
    body: "(trigger = ANY (ARRAY['overpressure_kpa'::text, 'impulse_kpa_ms'::text, 'fire_exposure_s'::text, 'ceiling_temp_c'::text, 'radiant_kw_m2'::text, 'structural_state'::text, 'vehicle_impact_kj'::text, 'flood_depth_m'::text, 'power_loss'::text, 'gas_in_flammable_range'::text]))",
  },
  {
    table: 'fieldops_hazard_item_kinds',
    name: 'fieldops_hazard_item_kinds_activation_c_check',
    body: '((activation_c IS NULL) OR ((activation_c >= (40)::numeric) AND (activation_c <= (300)::numeric)))',
  },
  {
    table: 'fieldops_hazard_item_kinds',
    name: 'fieldops_hazard_item_kinds_agent_key_check',
    body: "((agent_key IS NULL) OR (agent_key ~ '^[a-z][a-z0-9_]{1,47}$'::text))",
  },
  {
    table: 'fieldops_hazard_item_kinds',
    name: 'fieldops_hazard_item_kinds_category_check',
    body: "(category = ANY (ARRAY['flammable_gas'::text, 'flammable_liquid'::text, 'toxic_chemical'::text, 'oxidiser'::text, 'pressurised_gas'::text, 'electrical'::text, 'battery'::text, 'fuel_store'::text, 'combustible_store'::text, 'explosive_store'::text, 'mitigation'::text, 'utility'::text]))",
  },
  {
    table: 'fieldops_hazard_item_kinds',
    name: 'fieldops_hazard_item_kinds_explosive',
    body: "((category <> 'explosive_store'::text) OR ((sensitivity = 'restricted_generic'::text) AND (threat_keys = '{}'::text[])))",
  },
  {
    table: 'fieldops_hazard_item_kinds',
    name: 'fieldops_hazard_item_kinds_flash_point_c_check',
    body: "((flash_point_c IS NULL) OR ((flash_point_c >= ('-200'::integer)::numeric) AND (flash_point_c <= (400)::numeric)))",
  },
  {
    table: 'fieldops_hazard_item_kinds',
    name: 'fieldops_hazard_item_kinds_kind_key_check',
    body: "(kind_key ~ '^[a-z][a-z0-9_]{1,47}$'::text)",
  },
  {
    table: 'fieldops_hazard_item_kinds',
    name: 'fieldops_hazard_item_kinds_label_check',
    body: '((char_length(label) >= 1) AND (char_length(label) <= 80))',
  },
  {
    table: 'fieldops_hazard_item_kinds',
    name: 'fieldops_hazard_item_kinds_mitigates_check',
    body: "((mitigates IS NULL) OR (mitigates = ANY (ARRAY['fire_growth'::text, 'smoke'::text, 'gas'::text, 'power'::text])))",
  },
  {
    table: 'fieldops_hazard_item_kinds',
    name: 'fieldops_hazard_item_kinds_mitigation',
    body: "((category = 'mitigation'::text) = (mitigates IS NOT NULL))",
  },
  {
    table: 'fieldops_hazard_item_kinds',
    name: 'fieldops_hazard_item_kinds_phase_check',
    body: "(phase = ANY (ARRAY['gas'::text, 'liquefied_gas'::text, 'liquid'::text, 'solid'::text, 'equipment'::text, 'system'::text]))",
  },
  {
    table: 'fieldops_hazard_item_kinds',
    name: 'fieldops_hazard_item_kinds_row_version_check',
    body: '(row_version >= 1)',
  },
  {
    table: 'fieldops_hazard_item_kinds',
    name: 'fieldops_hazard_item_kinds_rti_check',
    body: '((rti IS NULL) OR ((rti >= (10)::numeric) AND (rti <= (500)::numeric)))',
  },
  {
    table: 'fieldops_hazard_item_kinds',
    name: 'fieldops_hazard_item_kinds_sensitivity_check',
    body: "(sensitivity = ANY (ARRAY['public'::text, 'restricted_generic'::text]))",
  },
  {
    table: 'fieldops_hazard_item_kinds',
    name: 'fieldops_hazard_item_kinds_source_note_check',
    body: '((char_length(source_note) >= 3) AND (char_length(source_note) <= 400))',
  },
  {
    table: 'fieldops_hazard_item_kinds',
    name: 'fieldops_hazard_item_kinds_source_ref_check',
    body: '((char_length(source_ref) >= 3) AND (char_length(source_ref) <= 300))',
  },
  {
    table: 'fieldops_hazard_item_kinds',
    name: 'fieldops_hazard_item_kinds_status_check',
    body: "(status = ANY (ARRAY['active'::text, 'retired'::text]))",
  },
  {
    table: 'fieldops_hazard_item_kinds',
    name: 'fieldops_hazard_item_kinds_stored_pressure_bar_check',
    body: '((stored_pressure_bar IS NULL) OR ((stored_pressure_bar >= (0)::numeric) AND (stored_pressure_bar <= (400)::numeric)))',
  },
  {
    table: 'fieldops_hospital_specialties',
    name: 'fieldops_hospital_specialties_level_check',
    body: "((level IS NULL) OR (level = ANY (ARRAY['national_centre'::text, 'regional'::text, 'service'::text])))",
  },
  {
    table: 'fieldops_hospital_specialties',
    name: 'fieldops_hospital_specialties_locator_check',
    body: '((locator IS NULL) OR ((char_length(locator) >= 1) AND (char_length(locator) <= 120)))',
  },
  {
    table: 'fieldops_hospital_specialties',
    name: 'fieldops_hospital_specialties_note_check',
    body: '((note IS NULL) OR (char_length(note) <= 300))',
  },
  {
    table: 'fieldops_hospital_specialties',
    name: 'fieldops_hospital_specialties_role_check',
    body: "(role = ANY (ARRAY['trauma_centre'::text, 'burns_centre'::text, 'paediatric'::text, 'paediatric_emergency'::text, 'neurosurgery'::text, 'cardiothoracic'::text, 'spinal'::text, 'hyperbaric'::text, 'toxicology'::text, 'decontamination'::text, 'obstetric'::text, 'ophthalmology'::text, 'psychiatric'::text, 'infectious_isolation'::text]))",
  },
  {
    table: 'fieldops_hospital_specialties',
    name: 'fieldops_hospital_specialties_status_check',
    body: "(status = ANY (ARRAY['sourced'::text, 'unverified'::text, 'assumed'::text]))",
  },
  {
    table: 'fieldops_hospitals',
    name: 'fieldops_hospitals_beds_check',
    body: '((beds IS NULL) OR ((beds >= 0) AND (beds <= 20000)))',
  },
  {
    table: 'fieldops_hospitals',
    name: 'fieldops_hospitals_beds_year_check',
    body: '((beds_year IS NULL) OR ((beds_year >= 2000) AND (beds_year <= 2100)))',
  },
  {
    table: 'fieldops_hospitals',
    name: 'fieldops_hospitals_cluster_check',
    body: '((cluster IS NULL) OR ((char_length(cluster) >= 2) AND (char_length(cluster) <= 80)))',
  },
  {
    table: 'fieldops_hospitals',
    name: 'fieldops_hospitals_country_check',
    body: "(country ~ '^[A-Z]{2}$'::text)",
  },
  {
    table: 'fieldops_hospitals',
    name: 'fieldops_hospitals_hospital_key_check',
    body: "(hospital_key ~ '^[a-z][a-z0-9_]{1,63}$'::text)",
  },
  {
    table: 'fieldops_hospitals',
    name: 'fieldops_hospitals_lat_check',
    body: "((lat IS NULL) OR ((lat >= ('-90'::integer)::double precision) AND (lat <= (90)::double precision)))",
  },
  {
    table: 'fieldops_hospitals',
    name: 'fieldops_hospitals_lng_check',
    body: "((lng IS NULL) OR ((lng >= ('-180'::integer)::double precision) AND (lng <= (180)::double precision)))",
  },
  {
    table: 'fieldops_hospitals',
    name: 'fieldops_hospitals_name_check',
    body: '((char_length(name) >= 2) AND (char_length(name) <= 160))',
  },
  {
    table: 'fieldops_hospitals',
    name: 'fieldops_hospitals_ownership_check',
    body: "(ownership = ANY (ARRAY['public'::text, 'private'::text, 'community'::text, 'military'::text]))",
  },
  {
    table: 'fieldops_hospitals',
    name: 'fieldops_hospitals_source_note_check',
    body: '((char_length(source_note) >= 3) AND (char_length(source_note) <= 400))',
  },
  {
    table: 'fieldops_hospitals',
    name: 'fieldops_hospitals_source_ref_check',
    body: '((char_length(source_ref) >= 3) AND (char_length(source_ref) <= 300))',
  },
  {
    table: 'fieldops_hospitals',
    name: 'fieldops_hospitals_stated_values_check',
    body: "(jsonb_typeof(stated_values) = 'array'::text)",
  },
  {
    table: 'fieldops_hospitals',
    name: 'fieldops_hospitals_status_check',
    body: "(status = ANY (ARRAY['active'::text, 'retired'::text]))",
  },
  {
    table: 'fieldops_incident_types',
    name: 'fieldops_incident_types_briefing_note_check',
    body: '((char_length(briefing_note) >= 3) AND (char_length(briefing_note) <= 400))',
  },
  {
    table: 'fieldops_incident_types',
    name: 'fieldops_incident_types_event_kind_check',
    body: "(event_kind = ANY (ARRAY['device'::text, 'crowd_trigger'::text, 'vehicle_path'::text, 'aircraft_impact'::text, 'ignition'::text, 'gas_leak'::text, 'release'::text, 'collapse_zone'::text, 'train_event'::text, 'road_collision'::text, 'rainfall'::text, 'utility_outage'::text, 'attacker_route'::text]))",
  },
  {
    table: 'fieldops_incident_types',
    name: 'fieldops_incident_types_incident_type_check',
    body: "(incident_type ~ '^[a-z][a-z0-9_]{1,47}$'::text)",
  },
  {
    table: 'fieldops_incident_types',
    name: 'fieldops_incident_types_label_check',
    body: '((char_length(label) >= 1) AND (char_length(label) <= 80))',
  },
  {
    table: 'fieldops_incident_types',
    name: 'fieldops_incident_types_phase_check',
    body: '((phase >= 1) AND (phase <= 3))',
  },
  {
    table: 'fieldops_incident_types',
    name: 'fieldops_incident_types_responder_archetypes_check',
    body: '(cardinality(responder_archetypes) >= 2)',
  },
  {
    table: 'fieldops_incident_types',
    name: 'fieldops_incident_types_row_version_check',
    body: '(row_version >= 1)',
  },
  {
    table: 'fieldops_incident_types',
    name: 'fieldops_incident_types_sensitivity_check',
    body: "(sensitivity = ANY (ARRAY['public'::text, 'restricted_generic'::text]))",
  },
  {
    table: 'fieldops_incident_types',
    name: 'fieldops_incident_types_source_note_check',
    body: '((char_length(source_note) >= 3) AND (char_length(source_note) <= 400))',
  },
  {
    table: 'fieldops_incident_types',
    name: 'fieldops_incident_types_source_ref_check',
    body: '((char_length(source_ref) >= 3) AND (char_length(source_ref) <= 300))',
  },
  {
    table: 'fieldops_incident_types',
    name: 'fieldops_incident_types_status_check',
    body: "(status = ANY (ARRAY['active'::text, 'retired'::text]))",
  },
  {
    table: 'fieldops_incident_types',
    name: 'fieldops_incident_types_template_file_check',
    body: "(template_file ~ '^[a-z][a-z0-9_]{1,47}\\.json$'::text)",
  },
  {
    table: 'fieldops_incident_types',
    name: 'fieldops_incident_types_threat_keys_check',
    body: '(cardinality(threat_keys) >= 1)',
  },
  {
    table: 'fieldops_incident_types',
    name: 'fieldops_incident_types_type_group_check',
    body: "(type_group = ANY (ARRAY['explosives'::text, 'crowd_and_vehicle'::text, 'fire_and_explosion'::text, 'hazardous_materials'::text, 'structural_and_transport'::text, 'natural_hazards'::text, 'armed_attack'::text, 'utilities'::text]))",
  },
  {
    table: 'fieldops_injury_thresholds',
    name: 'ck_fieldops_injury_thresholds_key_band',
    body: "(((threshold_key = 'lethal_onset'::text) AND (band = 'lethal'::text)) OR ((threshold_key = 'serious_injury_onset'::text) AND (band = 'serious'::text)) OR ((threshold_key = ANY (ARRAY['minor_injury_onset'::text, 'glass_injury'::text])) AND (band = 'minor'::text)) OR ((threshold_key = ANY (ARRAY['glass_breakage'::text, 'structural_light'::text, 'structural_moderate'::text, 'structural_severe'::text])) AND (band = 'structural'::text)) OR ((threshold_key = 'fragment_hazard'::text) AND (band = 'fragment'::text)))",
  },
  {
    table: 'fieldops_injury_thresholds',
    name: 'ck_fieldops_injury_thresholds_shape',
    body: "(((effect_class = 'injury'::text) AND (threshold_key = ANY (ARRAY['lethal_onset'::text, 'serious_injury_onset'::text, 'minor_injury_onset'::text])) AND (metric = 'effective_overpressure_kpa'::text)) OR ((effect_class = 'injury'::text) AND (threshold_key = 'glass_injury'::text) AND (metric = 'peak_overpressure_kpa'::text)) OR ((effect_class = 'damage'::text) AND (band = 'structural'::text) AND (metric = 'peak_overpressure_kpa'::text)) OR ((effect_class = 'fragment'::text) AND (band = 'fragment'::text) AND (metric = 'kinetic_energy_j'::text)))",
  },
  {
    table: 'fieldops_injury_thresholds',
    name: 'fieldops_injury_thresholds_applies_to_check',
    body: "(applies_to = ANY (ARRAY['all'::text, 'glazed_only'::text]))",
  },
  {
    table: 'fieldops_injury_thresholds',
    name: 'fieldops_injury_thresholds_band_check',
    body: "(band = ANY (ARRAY['lethal'::text, 'serious'::text, 'minor'::text, 'structural'::text, 'fragment'::text]))",
  },
  {
    table: 'fieldops_injury_thresholds',
    name: 'fieldops_injury_thresholds_effect_class_check',
    body: "(effect_class = ANY (ARRAY['injury'::text, 'damage'::text, 'fragment'::text]))",
  },
  {
    table: 'fieldops_injury_thresholds',
    name: 'fieldops_injury_thresholds_label_check',
    body: '((char_length(label) >= 3) AND (char_length(label) <= 120))',
  },
  {
    table: 'fieldops_injury_thresholds',
    name: 'fieldops_injury_thresholds_metric_check',
    body: "(metric = ANY (ARRAY['effective_overpressure_kpa'::text, 'peak_overpressure_kpa'::text, 'kinetic_energy_j'::text]))",
  },
  {
    table: 'fieldops_injury_thresholds',
    name: 'fieldops_injury_thresholds_review_state_check',
    body: "(review_state = ANY (ARRAY['unreviewed'::text, 'reviewed'::text]))",
  },
  {
    table: 'fieldops_injury_thresholds',
    name: 'fieldops_injury_thresholds_source_ref_check',
    body: '((char_length(source_ref) >= 3) AND (char_length(source_ref) <= 500))',
  },
  {
    table: 'fieldops_injury_thresholds',
    name: 'fieldops_injury_thresholds_status_check',
    body: "(status = ANY (ARRAY['active'::text, 'retired'::text]))",
  },
  {
    table: 'fieldops_injury_thresholds',
    name: 'fieldops_injury_thresholds_threshold_key_check',
    body: "(threshold_key = ANY (ARRAY['lethal_onset'::text, 'serious_injury_onset'::text, 'minor_injury_onset'::text, 'glass_injury'::text, 'glass_breakage'::text, 'structural_light'::text, 'structural_moderate'::text, 'structural_severe'::text, 'fragment_hazard'::text]))",
  },
  {
    table: 'fieldops_injury_thresholds',
    name: 'fieldops_injury_thresholds_value_check',
    body: '((value > (0)::numeric) AND (value < (100000)::numeric))',
  },
  {
    table: 'fieldops_injury_thresholds',
    name: 'fieldops_injury_thresholds_version_check',
    body: '(version >= 1)',
  },
  {
    table: 'fieldops_knowledge_reference_values',
    name: 'fieldops_knowledge_reference_values_confidence_check',
    body: "((confidence IS NULL) OR (confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])))",
  },
  {
    table: 'fieldops_knowledge_reference_values',
    name: 'fieldops_knowledge_reference_values_extends_check',
    body: '((extends IS NULL) OR (char_length(extends) <= 400))',
  },
  {
    table: 'fieldops_knowledge_reference_values',
    name: 'fieldops_knowledge_reference_values_formula_check',
    body: '((formula IS NULL) OR (char_length(formula) <= 2000))',
  },
  {
    table: 'fieldops_knowledge_reference_values',
    name: 'fieldops_knowledge_reference_values_library_check',
    body: "(library = ANY (ARRAY['doctrines'::text, 'devices'::text, 'spread'::text, 'threats'::text, 'building_hazards'::text, 'movement'::text, 'units'::text, 'hospitals'::text, 'blast_effects'::text, 'fire_smoke_tenability'::text]))",
  },
  {
    table: 'fieldops_knowledge_reference_values',
    name: 'fieldops_knowledge_reference_values_note_check',
    body: '((note IS NULL) OR (char_length(note) <= 4000))',
  },
  {
    table: 'fieldops_knowledge_reference_values',
    name: 'fieldops_knowledge_reference_values_provenance_check',
    body: "(jsonb_typeof(provenance) = 'object'::text)",
  },
  {
    table: 'fieldops_knowledge_reference_values',
    name: 'fieldops_knowledge_reference_values_ref_key_check',
    body: "(ref_key ~ '^[a-z0-9][a-z0-9_.-]{1,119}$'::text)",
  },
  {
    table: 'fieldops_knowledge_reference_values',
    name: 'fieldops_knowledge_reference_values_row_version_check',
    body: '(row_version >= 1)',
  },
  {
    table: 'fieldops_knowledge_reference_values',
    name: 'fieldops_knowledge_reference_values_spec_ref_check',
    body: '((spec_ref IS NULL) OR (char_length(spec_ref) <= 400))',
  },
  {
    table: 'fieldops_knowledge_reference_values',
    name: 'fieldops_knowledge_reference_values_status_check',
    body: "(status = ANY (ARRAY['active'::text, 'retired'::text]))",
  },
  {
    table: 'fieldops_knowledge_reference_values',
    name: 'fieldops_knowledge_reference_values_topic_check',
    body: '((char_length(topic) >= 1) AND (char_length(topic) <= 60))',
  },
  {
    table: 'fieldops_knowledge_reference_values',
    name: 'fieldops_knowledge_reference_values_unit_check',
    body: '((char_length(unit) >= 1) AND (char_length(unit) <= 120))',
  },
  {
    table: 'fieldops_knowledge_sources',
    name: 'fieldops_knowledge_sources_content_hash_check',
    body: "((content_hash IS NULL) OR (content_hash ~ '^[0-9a-f]{64}$'::text))",
  },
  {
    table: 'fieldops_knowledge_sources',
    name: 'fieldops_knowledge_sources_language_check',
    body: "(language ~ '^[a-z]{2,3}$'::text)",
  },
  {
    table: 'fieldops_knowledge_sources',
    name: 'fieldops_knowledge_sources_libraries_check',
    body: '(cardinality(libraries) >= 1)',
  },
  {
    table: 'fieldops_knowledge_sources',
    name: 'fieldops_knowledge_sources_publisher_check',
    body: '((char_length(publisher) >= 2) AND (char_length(publisher) <= 200))',
  },
  {
    table: 'fieldops_knowledge_sources',
    name: 'fieldops_knowledge_sources_review_interval_days_check',
    body: '((review_interval_days >= 30) AND (review_interval_days <= 1825))',
  },
  {
    table: 'fieldops_knowledge_sources',
    name: 'fieldops_knowledge_sources_source_key_check',
    body: "(source_key ~ '^[a-z0-9][a-z0-9_.:-]{2,119}$'::text)",
  },
  {
    table: 'fieldops_knowledge_sources',
    name: 'fieldops_knowledge_sources_status_check',
    body: "(status = ANY (ARRAY['active'::text, 'superseded'::text, 'withdrawn'::text]))",
  },
  {
    table: 'fieldops_knowledge_sources',
    name: 'fieldops_knowledge_sources_terms_note_check',
    body: '((char_length(terms_note) >= 3) AND (char_length(terms_note) <= 300))',
  },
  {
    table: 'fieldops_knowledge_sources',
    name: 'fieldops_knowledge_sources_title_check',
    body: '((char_length(title) >= 3) AND (char_length(title) <= 300))',
  },
  {
    table: 'fieldops_knowledge_sources',
    name: 'fieldops_knowledge_sources_url_check',
    body: "((url IS NULL) OR ((char_length(url) <= 1000) AND (url ~ '^https://'::text)))",
  },
  {
    table: 'fieldops_movement_parameters',
    name: 'fieldops_movement_parameters_applies_to_check',
    body: "(applies_to = ANY (ARRAY['walking'::text, 'stairs'::text, 'crouch'::text, 'crawl'::text, 'visibility'::text, 'heat'::text, 'gas'::text, 'water'::text, 'exit'::text, 'group'::text]))",
  },
  {
    table: 'fieldops_movement_parameters',
    name: 'fieldops_movement_parameters_label_check',
    body: '((char_length(label) >= 1) AND (char_length(label) <= 120))',
  },
  {
    table: 'fieldops_movement_parameters',
    name: 'fieldops_movement_parameters_param_key_check',
    body: "(param_key ~ '^[a-z][a-z0-9_]{1,63}$'::text)",
  },
  {
    table: 'fieldops_movement_parameters',
    name: 'fieldops_movement_parameters_range',
    body: '((plausible_low <= value) AND (value <= plausible_high))',
  },
  {
    table: 'fieldops_movement_parameters',
    name: 'fieldops_movement_parameters_row_version_check',
    body: '(row_version >= 1)',
  },
  {
    table: 'fieldops_movement_parameters',
    name: 'fieldops_movement_parameters_source_note_check',
    body: '((char_length(source_note) >= 3) AND (char_length(source_note) <= 400))',
  },
  {
    table: 'fieldops_movement_parameters',
    name: 'fieldops_movement_parameters_source_ref_check',
    body: '((char_length(source_ref) >= 3) AND (char_length(source_ref) <= 300))',
  },
  {
    table: 'fieldops_movement_parameters',
    name: 'fieldops_movement_parameters_status_check',
    body: "(status = ANY (ARRAY['active'::text, 'retired'::text]))",
  },
  {
    table: 'fieldops_movement_parameters',
    name: 'fieldops_movement_parameters_unit_check',
    body: "(unit = ANY (ARRAY['m_s'::text, 'p_m2'::text, 'm2_p'::text, 'p_s_m'::text, 'm'::text, 'c'::text, 'kw_m2'::text, 'per_m'::text, 'm2_g'::text, 'ratio'::text, 's'::text, 'permille'::text, 'ppm'::text, 'pct'::text]))",
  },
  {
    table: 'fieldops_release_agents',
    name: 'fieldops_release_agents_agent_key_check',
    body: "(agent_key ~ '^[a-z][a-z0-9_]{1,47}$'::text)",
  },
  {
    table: 'fieldops_release_agents',
    name: 'fieldops_release_agents_boiling_point_c_check',
    body: "((boiling_point_c IS NULL) OR ((boiling_point_c >= ('-273'::integer)::numeric) AND (boiling_point_c <= (500)::numeric)))",
  },
  {
    table: 'fieldops_release_agents',
    name: 'fieldops_release_agents_cas_number_check',
    body: "((cas_number IS NULL) OR (cas_number ~ '^[0-9]{2,7}-[0-9]{2}-[0-9]$'::text))",
  },
  {
    table: 'fieldops_release_agents',
    name: 'fieldops_release_agents_density_ratio_check',
    body: '((density_ratio >= 0.05) AND (density_ratio <= (10)::numeric))',
  },
  {
    table: 'fieldops_release_agents',
    name: 'fieldops_release_agents_flammable',
    body: '(((lfl_pct IS NULL) = (ufl_pct IS NULL)) AND ((lfl_pct IS NULL) OR (lfl_pct < ufl_pct)))',
  },
  {
    table: 'fieldops_release_agents',
    name: 'fieldops_release_agents_label_check',
    body: '((char_length(label) >= 1) AND (char_length(label) <= 80))',
  },
  {
    table: 'fieldops_release_agents',
    name: 'fieldops_release_agents_lfl_pct_check',
    body: '((lfl_pct IS NULL) OR ((lfl_pct >= 0.1) AND (lfl_pct <= (100)::numeric)))',
  },
  {
    table: 'fieldops_release_agents',
    name: 'fieldops_release_agents_molecular_weight_check',
    body: '((molecular_weight >= (1)::numeric) AND (molecular_weight <= (500)::numeric))',
  },
  {
    table: 'fieldops_release_agents',
    name: 'fieldops_release_agents_row_version_check',
    body: '(row_version >= 1)',
  },
  {
    table: 'fieldops_release_agents',
    name: 'fieldops_release_agents_source_note_check',
    body: '((char_length(source_note) >= 3) AND (char_length(source_note) <= 400))',
  },
  {
    table: 'fieldops_release_agents',
    name: 'fieldops_release_agents_source_ref_check',
    body: '((char_length(source_ref) >= 3) AND (char_length(source_ref) <= 300))',
  },
  {
    table: 'fieldops_release_agents',
    name: 'fieldops_release_agents_status_check',
    body: "(status = ANY (ARRAY['active'::text, 'retired'::text]))",
  },
  {
    table: 'fieldops_release_agents',
    name: 'fieldops_release_agents_tier_scheme_check',
    body: "((tier_scheme IS NULL) OR (tier_scheme = ANY (ARRAY['aegl'::text, 'erpg'::text, 'teel'::text])))",
  },
  {
    table: 'fieldops_release_agents',
    name: 'fieldops_release_agents_tiers_check',
    body: "(jsonb_typeof(tiers) = 'array'::text)",
  },
  {
    table: 'fieldops_release_agents',
    name: 'fieldops_release_agents_tiers',
    body: '((tier_scheme IS NULL) = (jsonb_array_length(tiers) = 0))',
  },
  {
    table: 'fieldops_release_agents',
    name: 'fieldops_release_agents_toxic_load_n_check',
    body: '((toxic_load_n IS NULL) OR ((toxic_load_n >= 0.5) AND (toxic_load_n <= (4)::numeric)))',
  },
  {
    table: 'fieldops_release_agents',
    name: 'fieldops_release_agents_ufl_pct_check',
    body: '((ufl_pct IS NULL) OR ((ufl_pct >= 0.1) AND (ufl_pct <= (100)::numeric)))',
  },
  {
    table: 'fieldops_response_standards',
    name: 'fieldops_response_standards_answer_within_s_check',
    body: '((answer_within_s IS NULL) OR ((answer_within_s >= 1) AND (answer_within_s <= 3600)))',
  },
  {
    table: 'fieldops_response_standards',
    name: 'fieldops_response_standards_country_check',
    body: "(country ~ '^[A-Z]{2}$'::text)",
  },
  {
    table: 'fieldops_response_standards',
    name: 'fieldops_response_standards_label_check',
    body: '((char_length(label) >= 1) AND (char_length(label) <= 120))',
  },
  {
    table: 'fieldops_response_standards',
    name: 'fieldops_response_standards_measured_from_check',
    body: "((measured_from IS NULL) OR (measured_from = ANY (ARRAY['call_receipt'::text, 'dispatch'::text, 'unknown'::text])))",
  },
  {
    table: 'fieldops_response_standards',
    name: 'fieldops_response_standards_respond_within_s_check',
    body: '((respond_within_s IS NULL) OR ((respond_within_s >= 1) AND (respond_within_s <= 86400)))',
  },
  {
    table: 'fieldops_response_standards',
    name: 'fieldops_response_standards_scope_check',
    body: "(scope ~ '^[a-z][a-z0-9_]{1,63}$'::text)",
  },
  {
    table: 'fieldops_response_standards',
    name: 'fieldops_response_standards_source_note_check',
    body: '((char_length(source_note) >= 3) AND (char_length(source_note) <= 400))',
  },
  {
    table: 'fieldops_response_standards',
    name: 'fieldops_response_standards_source_ref_check',
    body: '((char_length(source_ref) >= 3) AND (char_length(source_ref) <= 300))',
  },
  {
    table: 'fieldops_response_standards',
    name: 'fieldops_response_standards_standard_key_check',
    body: "(standard_key ~ '^[a-z][a-z0-9_]{1,63}$'::text)",
  },
  {
    table: 'fieldops_response_standards',
    name: 'fieldops_response_standards_stated_values_check',
    body: "(jsonb_typeof(stated_values) = 'array'::text)",
  },
  {
    table: 'fieldops_response_standards',
    name: 'fieldops_response_standards_status_check',
    body: "(status = ANY (ARRAY['active'::text, 'retired'::text]))",
  },
  {
    table: 'fieldops_response_standards',
    name: 'fieldops_response_standards_target_share_pct_check',
    body: '((target_share_pct IS NULL) OR ((target_share_pct >= (0)::numeric) AND (target_share_pct <= (100)::numeric)))',
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_burn_duration_s_check',
    body: '((burn_duration_s IS NULL) OR ((burn_duration_s >= 10) AND (burn_duration_s <= 14400)))',
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_burn_through_s_check',
    body: '((burn_through_s IS NULL) OR ((burn_through_s >= 10) AND (burn_through_s <= 86400)))',
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_co_yield_check',
    body: '((co_yield IS NULL) OR ((co_yield >= (0)::numeric) AND (co_yield <= 0.3)))',
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_co_yield_post_fo_check',
    body: '((co_yield_post_fo IS NULL) OR ((co_yield_post_fo >= (0)::numeric) AND (co_yield_post_fo <= 0.5)))',
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_contents',
    body: "((material_role <> 'contents'::text) OR ((flame_spread_m_min IS NOT NULL) AND (burn_duration_s IS NOT NULL) AND (extinguish_s IS NOT NULL)))",
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_creep_per_min_check',
    body: '((creep_per_min IS NULL) OR ((creep_per_min >= (0)::numeric) AND (creep_per_min <= (100)::numeric)))',
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_critical_heat_flux_kw_m2_check',
    body: '((critical_heat_flux_kw_m2 IS NULL) OR ((critical_heat_flux_kw_m2 >= (5)::numeric) AND (critical_heat_flux_kw_m2 <= (50)::numeric)))',
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_extinguish_s_check',
    body: '((extinguish_s IS NULL) OR ((extinguish_s >= 5) AND (extinguish_s <= 3600)))',
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_fire_resistance_min_check',
    body: '((fire_resistance_min IS NULL) OR ((fire_resistance_min >= 5) AND (fire_resistance_min <= 480)))',
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_fire',
    body: "((material_role <> 'contents'::text) OR ((hrrpua_kw_m2 IS NOT NULL) AND (heat_of_combustion_mj_kg IS NOT NULL) AND (soot_yield IS NOT NULL) AND (co_yield IS NOT NULL)))",
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_flame_spread_m_min_check',
    body: '((flame_spread_m_min IS NULL) OR ((flame_spread_m_min >= 0.01) AND (flame_spread_m_min <= (30)::numeric)))',
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_gas_leak_check',
    body: '((gas_leak >= (0)::numeric) AND (gas_leak <= (1)::numeric))',
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_glazed',
    body: "((glazed = false) OR (material_role = 'wall'::text))",
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_heat_of_combustion_mj_kg_check',
    body: '((heat_of_combustion_mj_kg IS NULL) OR ((heat_of_combustion_mj_kg >= (5)::numeric) AND (heat_of_combustion_mj_kg <= (50)::numeric)))',
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_heat_release_check',
    body: "(heat_release = ANY (ARRAY['none'::text, 'slow'::text, 'medium'::text, 'fast'::text, 'ultra_fast'::text]))",
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_hrrpua_kw_m2_check',
    body: '((hrrpua_kw_m2 IS NULL) OR ((hrrpua_kw_m2 >= 50) AND (hrrpua_kw_m2 <= 5000)))',
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_label_check',
    body: '((char_length(label) >= 1) AND (char_length(label) <= 80))',
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_lining_krhoc_check',
    body: '((lining_krhoc IS NULL) OR ((lining_krhoc >= 0.001) AND (lining_krhoc <= (10)::numeric)))',
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_material_key_check',
    body: "(material_key ~ '^[a-z][a-z0-9_]{1,47}$'::text)",
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_material_role_check',
    body: "(material_role = ANY (ARRAY['wall'::text, 'contents'::text, 'structure'::text]))",
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_row_version_check',
    body: '(row_version >= 1)',
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_smoke_leak_check',
    body: '((smoke_leak >= (0)::numeric) AND (smoke_leak <= (1)::numeric))',
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_smoke_yield_check',
    body: "(smoke_yield = ANY (ARRAY['none'::text, 'light'::text, 'moderate'::text, 'heavy'::text, 'toxic'::text]))",
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_soot_yield_check',
    body: '((soot_yield IS NULL) OR ((soot_yield >= (0)::numeric) AND (soot_yield <= 0.3)))',
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_soot_yield_post_fo_check',
    body: '((soot_yield_post_fo IS NULL) OR ((soot_yield_post_fo >= (0)::numeric) AND (soot_yield_post_fo <= 0.5)))',
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_source_note_check',
    body: '((char_length(source_note) >= 3) AND (char_length(source_note) <= 400))',
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_source_ref_check',
    body: '((char_length(source_ref) >= 3) AND (char_length(source_ref) <= 300))',
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_status_check',
    body: "(status = ANY (ARRAY['active'::text, 'retired'::text]))",
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_structure',
    body: "((material_role <> 'structure'::text) OR ((fire_resistance_min IS NOT NULL) AND (creep_per_min IS NOT NULL)))",
  },
  {
    table: 'fieldops_spread_materials',
    name: 'fieldops_spread_materials_thermal_response_kw_s05_m2_check',
    body: '((thermal_response_kw_s05_m2 IS NULL) OR ((thermal_response_kw_s05_m2 >= (50)::numeric) AND (thermal_response_kw_s05_m2 <= (1000)::numeric)))',
  },
  {
    table: 'fieldops_threat_profiles',
    name: 'fieldops_threat_profiles_category_check',
    body: "(category = ANY (ARRAY['explosion'::text, 'fire'::text, 'toxic_release'::text, 'flammable_release'::text, 'structural_collapse'::text, 'vehicle_impact'::text, 'flood'::text, 'crowd_crush'::text, 'ramming'::text, 'aircraft_impact'::text, 'armed_attacker'::text, 'rail'::text, 'utility_failure'::text, 'earthquake'::text]))",
  },
  {
    table: 'fieldops_threat_profiles',
    name: 'fieldops_threat_profiles_environment_check',
    body: "(jsonb_typeof(environment) = 'array'::text)",
  },
  {
    table: 'fieldops_threat_profiles',
    name: 'fieldops_threat_profiles_label_check',
    body: '((char_length(label) >= 1) AND (char_length(label) <= 80))',
  },
  {
    table: 'fieldops_threat_profiles',
    name: 'fieldops_threat_profiles_model_check',
    body: "(model = ANY (ARRAY['blast_profile'::text, 'vessel_burst'::text, 'bleve_fireball'::text, 'vapour_cloud'::text, 'pool_fire'::text, 'jet_fire'::text, 'flash_fire'::text, 'gaussian_plume'::text, 'dense_gas_plume'::text, 'indoor_transport'::text, 'progressive_collapse'::text, 'kinetic_impact'::text, 'water_ingress'::text, 'crowd_pressure'::text, 'ramming_path'::text, 'aircraft_impact'::text, 'vented_deflagration'::text, 'shelter_in_place'::text, 'attacker_zone'::text, 'rolling_stock_fire'::text, 'surface_flood'::text, 'utility_cascade'::text, 'ground_shaking'::text]))",
  },
  {
    table: 'fieldops_threat_profiles',
    name: 'fieldops_threat_profiles_parameters_check',
    body: "((jsonb_typeof(parameters) = 'object'::text) AND (octet_length((parameters)::text) <= 16384))",
  },
  {
    table: 'fieldops_threat_profiles',
    name: 'fieldops_threat_profiles_row_version_check',
    body: '(row_version >= 1)',
  },
  {
    table: 'fieldops_threat_profiles',
    name: 'fieldops_threat_profiles_source_note_check',
    body: '((char_length(source_note) >= 3) AND (char_length(source_note) <= 400))',
  },
  {
    table: 'fieldops_threat_profiles',
    name: 'fieldops_threat_profiles_source_ref_check',
    body: '((char_length(source_ref) >= 3) AND (char_length(source_ref) <= 300))',
  },
  {
    table: 'fieldops_threat_profiles',
    name: 'fieldops_threat_profiles_status_check',
    body: "(status = ANY (ARRAY['active'::text, 'retired'::text]))",
  },
  {
    table: 'fieldops_threat_profiles',
    name: 'fieldops_threat_profiles_threat_key_check',
    body: "(threat_key ~ '^[a-z][a-z0-9_]{1,47}$'::text)",
  },
  {
    table: 'fieldops_unit_equipment',
    name: 'fieldops_unit_equipment_quantity_check',
    body: '((quantity >= 1) AND (quantity <= 50))',
  },
  {
    table: 'fieldops_unit_kinds',
    name: 'fieldops_unit_kinds_asset_type_check',
    body: "(asset_type ~ '^[a-z][a-z0-9_]{1,47}$'::text)",
  },
  {
    table: 'fieldops_unit_kinds',
    name: 'fieldops_unit_kinds_country_check',
    body: "((country IS NULL) OR (country ~ '^[A-Z]{2}$'::text))",
  },
  {
    table: 'fieldops_unit_kinds',
    name: 'fieldops_unit_kinds_crew_check',
    body: '((crew >= 1) AND (crew <= 20))',
  },
  {
    table: 'fieldops_unit_kinds',
    name: 'fieldops_unit_kinds_default_count_check',
    body: '((default_count >= 0) AND (default_count <= 8))',
  },
  {
    table: 'fieldops_unit_kinds',
    name: 'fieldops_unit_kinds_kind_key_check',
    body: "(kind_key ~ '^[a-z][a-z0-9_]{1,47}$'::text)",
  },
  {
    table: 'fieldops_unit_kinds',
    name: 'fieldops_unit_kinds_label_check',
    body: '((char_length(label) >= 1) AND (char_length(label) <= 80))',
  },
  {
    table: 'fieldops_unit_kinds',
    name: 'fieldops_unit_kinds_mode_check',
    body: "(mode = ANY (ARRAY['vehicle'::text, 'foot'::text, 'vessel'::text]))",
  },
  {
    table: 'fieldops_unit_kinds',
    name: 'fieldops_unit_kinds_observes_m_check',
    body: '((observes_m >= 10) AND (observes_m <= 500))',
  },
  {
    table: 'fieldops_unit_kinds',
    name: 'fieldops_unit_kinds_source_note_check',
    body: '((char_length(source_note) >= 3) AND (char_length(source_note) <= 400))',
  },
  {
    table: 'fieldops_unit_kinds',
    name: 'fieldops_unit_kinds_source_ref_check',
    body: '((char_length(source_ref) >= 3) AND (char_length(source_ref) <= 300))',
  },
  {
    table: 'fieldops_unit_kinds',
    name: 'fieldops_unit_kinds_status_check',
    body: "(status = ANY (ARRAY['active'::text, 'retired'::text]))",
  },
  {
    table: 'fieldops_unit_kinds',
    name: 'fieldops_unit_kinds_turnout_s_check',
    body: '((turnout_s >= 0) AND (turnout_s <= 3600))',
  },
  {
    table: 'team_archetype_aliases',
    name: 'team_archetype_aliases_agency_name_check',
    body: '((agency_name IS NULL) OR ((char_length(agency_name) >= 2) AND (char_length(agency_name) <= 120)))',
  },
  {
    table: 'team_archetype_aliases',
    name: 'team_archetype_aliases_country_check',
    body: "((country IS NULL) OR (country ~ '^[A-Z]{2}$'::text))",
  },
  {
    table: 'team_archetype_aliases',
    name: 'team_archetype_aliases_kind_check',
    body: "(kind = ANY (ARRAY['exact'::text, 'function'::text, 'organisation'::text]))",
  },
  {
    table: 'team_archetype_aliases',
    name: 'team_archetype_aliases_org_agency',
    body: "((kind <> 'organisation'::text) OR (country IS NULL) OR (agency_name IS NOT NULL))",
  },
  {
    table: 'team_archetype_aliases',
    name: 'team_archetype_aliases_phrase_check',
    body: '(((char_length(phrase) >= 2) AND (char_length(phrase) <= 80)) AND (phrase = lower(phrase)))',
  },
  {
    table: 'team_archetype_aliases',
    name: 'team_archetype_aliases_source_check',
    body: "(source = ANY (ARRAY['seeded'::text, 'admin'::text]))",
  },
  {
    table: 'team_archetype_aliases',
    name: 'team_archetype_aliases_source_ref_check',
    body: '((source_ref IS NULL) OR (char_length(source_ref) <= 200))',
  },
];

/** One row that satisfies every CHECK of its table. Promotion builds the real rows; these exist for U4 and I6. */
export const VALID_ROWS: Record<string, Record<string, unknown>> = {
  doctrine_versions: {
    content_bytes: 2,
    content: { note: 'ok' },
    content_hash: 'a'.repeat(64),
    review_note: null,
    review_status: 'unverified',
    reviewed_at: null,
    schema_version: 1,
    screen_flags: [],
    source_document_sha256: null,
    source_note: null,
    title: 'Library doctrine',
    version: 1,
  },
  doctrines: {
    title: 'Library doctrine',
    source: 'seeded',
    visibility: 'library',
    applies_to: [],
    latest_version: 1,
    country: 'SG',
    agency_name: 'Agency',
    establishment_type: null,
    latest_verified_version: null,
    parent_version: null,
    parent_doctrine_id: null,
    retired_reason: null,
    venue_scope: null,
  },
  fieldops_building_items: {
    type_key: 'office',
    kind_key: 'diesel',
    location_kind: 'ground',
    quantity_band: 'category_only',
    quantity_low: null,
    quantity_high: null,
    quantity_unit: null,
    likelihood_permille: 100,
    per_storey: false,
    auto_place: false,
    source_keys: [],
    source_ref: 'source',
    source_note: 'note',
    status: 'active',
    row_version: 1,
  },
  fieldops_building_types: {
    type_key: 'office',
    label: 'Office',
    country: 'SG',
    place_classes: [],
    building_tags: [],
    contents_key: 'contents_generic',
    frame_key: 'frame_unknown',
    smoke_control: false,
    basement_storey_height_m: 3,
    storey_height_m: 3,
    external_spread_permille: 100,
    sprinklered_permille: 100,
    facade_class: 'masonry',
    familiarity: 'familiar',
    occupancy_by_hour: [],
    occupant_m2_per_person: null,
    priority: 10,
    sensitivity: 'public',
    source_keys: [],
    source_ref: 'source',
    source_note: 'note',
    status: 'active',
    row_version: 1,
  },
  fieldops_capacity_aggregates: {
    aggregate_key: 'sg_beds',
    country: 'SG',
    label: 'Beds',
    scope: 'national_network',
    stated_values: [],
    source_keys: [],
    source_ref: 'source',
    source_note: 'note',
    status: 'active',
  },
  fieldops_equipment: {
    equipment_key: 'hose_one',
    label: 'Hose',
    category: 'hose',
    capacity: 1,
    unit: 'm',
    consumable: false,
    source_keys: [],
    source_ref: 'source',
    source_note: 'note',
    status: 'active',
    row_version: 1,
  },
  fieldops_explosive_materials: {
    material_key: 'tnt',
    label: 'TNT',
    aliases: [],
    tnt_eq_pressure: 1,
    tnt_eq_impulse: 1,
    confidence: 'high',
    is_unknown_default: false,
    sort_order: 1,
    source_ref: 'source',
    review_state: 'unreviewed',
    status: 'active',
    version: 1,
  },
  fieldops_hazard_interactions: {
    rule_key: 'rule_one',
    kind_key: 'diesel',
    effect: 'ignite',
    trigger: 'fire_exposure_s',
    threshold: 1,
    event_text: 'Starts a fire',
    delay_low_s: 0,
    delay_high_s: 10,
    probability_permille: 100,
    requires_ignition_source: false,
    agent_key: null,
    threat_key: null,
    source_keys: [],
    source_ref: 'source',
    source_note: 'note',
    status: 'active',
    row_version: 1,
  },
  fieldops_hazard_item_kinds: {
    kind_key: 'diesel',
    label: 'Diesel',
    category: 'flammable_liquid',
    phase: 'liquid',
    sensitivity: 'public',
    mitigates: null,
    threat_keys: [],
    agent_key: null,
    activation_c: null,
    flash_point_c: null,
    rti: null,
    stored_pressure_bar: null,
    source_keys: [],
    source_ref: 'source',
    source_note: 'note',
    status: 'active',
    row_version: 1,
  },
  fieldops_hospital_specialties: {
    hospital_key: 'sg_hosp_sgh',
    role: 'trauma_centre',
    level: null,
    status: 'sourced',
    locator: null,
    note: null,
  },
  fieldops_hospitals: {
    hospital_key: 'sg_hosp_sgh',
    name: 'General Hospital',
    country: 'SG',
    ownership: 'public',
    cluster: null,
    acute: true,
    emergency_department: true,
    lat: null,
    lng: null,
    beds: null,
    beds_year: null,
    stated_values: [],
    source_keys: [],
    source_ref: 'source',
    source_note: 'note',
    status: 'active',
    row_version: 1,
  },
  fieldops_incident_types: {
    incident_type: 'building_fire',
    label: 'Building fire',
    type_group: 'fire_and_explosion',
    phase: 1,
    event_kind: 'ignition',
    threat_keys: ['pool_fire'],
    responder_archetypes: ['fire_rescue', 'medical_triage'],
    template_file: 'building_fire.json',
    catalogue_needs: [],
    sensitivity: 'public',
    briefing_note: 'A fire',
    source_keys: [],
    source_ref: 'source',
    source_note: 'note',
    status: 'active',
    row_version: 1,
  },
  fieldops_injury_thresholds: {
    threshold_key: 'lethal_onset',
    band: 'lethal',
    effect_class: 'injury',
    metric: 'effective_overpressure_kpa',
    value: 100,
    applies_to: 'all',
    label: 'Lethal onset',
    source_ref: 'source',
    review_state: 'unreviewed',
    status: 'active',
    version: 1,
  },
  fieldops_knowledge_reference_values: {
    library: 'blast_effects',
    ref_key: 'ref.one',
    topic: 'pressure',
    unit: 'kPa',
    value: 1,
    formula: null,
    note: null,
    spec_ref: null,
    extends: null,
    provenance: {},
    confidence: null,
    assumed_fields: [],
    to_verify: [],
    source_keys: [],
    status: 'active',
    row_version: 1,
  },
  fieldops_knowledge_sources: {
    source_key: 'nfpa.1',
    title: 'A standard',
    publisher: 'NFPA',
    url: null,
    language: 'en',
    terms_note: 'terms of use',
    content_hash: null,
    accessed_on: '2026-11-22',
    next_review_due: '2027-11-22',
    review_interval_days: 365,
    libraries: ['blast_effects'],
    status: 'active',
  },
  fieldops_movement_parameters: {
    param_key: 'walk_speed',
    label: 'Walk',
    applies_to: 'walking',
    value: 1.2,
    unit: 'm_s',
    plausible_low: 0.5,
    plausible_high: 2,
    source_keys: [],
    source_ref: 'source',
    source_note: 'note',
    status: 'active',
    row_version: 1,
  },
  fieldops_release_agents: {
    agent_key: 'chlorine',
    label: 'Chlorine',
    cas_number: null,
    molecular_weight: 70.9,
    density_ratio: 2.5,
    boiling_point_c: null,
    lfl_pct: null,
    ufl_pct: null,
    tier_scheme: null,
    tiers: [],
    toxic_load_n: null,
    irritant: false,
    source_keys: [],
    source_ref: 'source',
    source_note: 'note',
    status: 'active',
    row_version: 1,
  },
  fieldops_response_standards: {
    standard_key: 'sg_fire_rescue_response',
    label: 'Fire response',
    country: 'SG',
    scope: 'national',
    respond_within_s: 480,
    answer_within_s: null,
    target_share_pct: 90,
    measured_from: null,
    stated_values: [],
    incident_types: [],
    site_bound: false,
    source_keys: [],
    source_ref: 'source',
    source_note: 'note',
    status: 'active',
  },
  fieldops_spread_materials: {
    material_key: 'brick',
    label: 'Brick',
    material_role: 'wall',
    aliases: [],
    combustible: false,
    glazed: false,
    smoke_leak: 0,
    gas_leak: 0,
    smoke_yield: 'none',
    heat_release: 'none',
    burn_duration_s: null,
    burn_through_s: null,
    co_yield: null,
    co_yield_post_fo: null,
    creep_per_min: null,
    critical_heat_flux_kw_m2: null,
    extinguish_s: null,
    fire_resistance_min: null,
    flame_spread_m_min: null,
    heat_of_combustion_mj_kg: null,
    hrrpua_kw_m2: null,
    lining_krhoc: null,
    soot_yield: null,
    soot_yield_post_fo: null,
    thermal_response_kw_s05_m2: null,
    source_ref: 'source',
    source_note: 'note',
    status: 'active',
    row_version: 1,
  },
  fieldops_threat_profiles: {
    threat_key: 'pool_fire',
    label: 'Pool fire',
    category: 'fire',
    model: 'pool_fire',
    parameters: { note: 'unchecked' },
    environment: [],
    source_keys: [],
    source_ref: 'source',
    source_note: 'note',
    status: 'active',
    row_version: 1,
  },
  fieldops_unit_equipment: { kind_key: 'sg_pump', equipment_key: 'hose_one', quantity: 1 },
  fieldops_unit_kinds: {
    kind_key: 'sg_pump',
    label: 'Pump',
    country: 'SG',
    mode: 'vehicle',
    crew: 4,
    default_count: 1,
    turnout_s: 60,
    observes_m: 60,
    asset_type: 'firefighter_post',
    archetype_key: 'fire_rescue',
    tasks: ['suppress'],
    starts_from: ['station'],
    source_keys: [],
    source_ref: 'source',
    source_note: 'note',
    status: 'active',
  },
  team_archetype_aliases: {
    phrase: 'fire rescue',
    kind: 'exact',
    country: 'SG',
    agency_name: 'SCDF',
    source: 'seeded',
    source_ref: null,
  },
};

export function checksFor(table: string): KnowledgeCheck[] {
  return KNOWLEDGE_CHECKS.filter((check) => check.table === table);
}

export function failedChecks(table: string, row: Record<string, unknown>): string[] {
  return checksFor(table)
    .filter((check) => !evaluateCheck(check.body, row))
    .map((check) => check.name);
}

export function rowIsValid(table: string, row: Record<string, unknown>): boolean {
  return failedChecks(table, row).length === 0;
}

const TRIALS: unknown[] = [
  null,
  '',
  'x',
  'NOPE',
  'ZZ',
  '!!!',
  'not_a_key',
  'a'.repeat(500),
  'a'.repeat(5000),
  -1,
  0,
  1,
  999999,
  [],
  ['nope'],
  {},
  [],
  true,
  false,
  'https://example.test',
];

/** A row that fails one named CHECK. U4 searches; the returned row is what I6 sends to Postgres. */
export function violatingRow(table: string, checkName: string): Record<string, unknown> {
  const valid = VALID_ROWS[table];
  if (!valid) throw new Error(`no valid row for ${table}`);
  const base = { ...valid };
  if (checkName === 'team_archetype_aliases_org_agency') {
    return { ...base, kind: 'organisation', country: 'SG', agency_name: null };
  }
  const keys = Object.keys(base);
  for (const key of keys) {
    for (const trial of TRIALS) {
      const row = { ...base, [key]: trial };
      const failed = failedChecks(table, row);
      if (failed.includes(checkName)) return row;
    }
  }
  for (const key of keys) {
    for (const other of keys) {
      if (other === key) continue;
      const row = { ...base, [key]: null, [other]: 'NOPE' };
      if (failedChecks(table, row).includes(checkName)) return row;
    }
  }
  throw new Error(`could not build a row that fails ${checkName}`);
}
