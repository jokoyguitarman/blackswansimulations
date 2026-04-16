import type { CasualtyVictim, TriageTag } from './types';

interface VictimPreset {
  trueTag: TriageTag;
  description: string;
  observableSigns: CasualtyVictim['observableSigns'];
}

// ── Kill zone: 0-10m from blast ─────────────────────────────────────────
const KILL_ZONE: VictimPreset[] = [
  {
    trueTag: 'black',
    description: 'Massive blast trauma, no signs of life, body severely damaged',
    observableSigns: {
      breathing: 'Absent',
      pulse: 'Absent',
      consciousness: 'Unresponsive',
      visibleInjuries: 'Catastrophic blast injuries, unsurvivable',
      mobility: 'Immobile',
      bleeding: 'Not assessable',
    },
  },
  {
    trueTag: 'black',
    description: 'Found face down, extensive blast fragmentation injuries, no pulse',
    observableSigns: {
      breathing: 'Absent',
      pulse: 'Absent',
      consciousness: 'Unresponsive',
      visibleInjuries: 'Multiple penetrating fragment wounds, massive tissue damage',
      mobility: 'Immobile',
      bleeding: 'Not assessable',
    },
  },
  {
    trueTag: 'black',
    description: 'Severe thermal and blast injuries, no respiratory effort',
    observableSigns: {
      breathing: 'Absent',
      pulse: 'Absent',
      consciousness: 'Unresponsive',
      visibleInjuries: 'Full-thickness burns, blast dismemberment',
      mobility: 'Immobile',
      bleeding: 'Not assessable',
    },
  },
  {
    trueTag: 'black',
    description: 'Thrown by blast force against wall, massive head injury, no vitals',
    observableSigns: {
      breathing: 'Absent',
      pulse: 'Absent',
      consciousness: 'Unresponsive',
      visibleInjuries: 'Severe head trauma, multiple fractures',
      mobility: 'Immobile',
      bleeding: 'Not assessable',
    },
  },
];

// ── Critical zone: 10-20m from blast ────────────────────────────────────
const CRITICAL_ZONE: VictimPreset[] = [
  {
    trueTag: 'red',
    description: 'Penetrating shrapnel to chest, struggling to breathe, conscious but fading',
    observableSigns: {
      breathing: 'Rapid, shallow, labored',
      pulse: 'Rapid and weak',
      consciousness: 'Responds to voice, confused',
      visibleInjuries: 'Penetrating chest wound with sucking sound, shrapnel embedded',
      mobility: 'Immobile',
      bleeding: 'Uncontrolled from chest',
    },
  },
  {
    trueTag: 'red',
    description: 'Blast lung injury, coughing blood, severe respiratory distress',
    observableSigns: {
      breathing: 'Wheezing, blood-tinged cough',
      pulse: 'Thready and rapid',
      consciousness: 'Alert but deteriorating',
      visibleInjuries: 'No visible external wounds, progressive respiratory failure',
      mobility: 'Cannot walk',
      bleeding: 'Coughing blood',
    },
  },
  {
    trueTag: 'red',
    description: 'Major arterial bleeding from leg, tourniquet needed urgently',
    observableSigns: {
      breathing: 'Rapid',
      pulse: 'Weak, rapid',
      consciousness: 'Alert but pale, anxious',
      visibleInjuries: 'Deep laceration to upper thigh, arterial bleed',
      mobility: 'Immobile',
      bleeding: 'Pulsatile arterial bleeding',
    },
  },
  {
    trueTag: 'black',
    description: 'Severe burns over 80% of body, airway compromised, minimal response',
    observableSigns: {
      breathing: 'Agonal, irregular',
      pulse: 'Barely palpable',
      consciousness: 'Unresponsive to voice, minimal pain response',
      visibleInjuries: 'Full-thickness burns face, torso, arms, airway swelling',
      mobility: 'Immobile',
      bleeding: 'None visible',
    },
  },
  {
    trueTag: 'red',
    description: 'Open abdominal wound from blast fragments, evisceration',
    observableSigns: {
      breathing: 'Shallow, guarding',
      pulse: 'Rapid, thready',
      consciousness: 'Conscious, screaming in pain',
      visibleInjuries: 'Open abdominal wound, exposed viscera',
      mobility: 'Immobile',
      bleeding: 'Moderate from abdomen',
    },
  },
];

// ── Serious zone: 20-40m from blast ─────────────────────────────────────
const SERIOUS_ZONE: VictimPreset[] = [
  {
    trueTag: 'red',
    description: 'Multiple shrapnel wounds to torso, difficulty breathing, altered consciousness',
    observableSigns: {
      breathing: 'Rapid, shallow',
      pulse: 'Rapid',
      consciousness: 'Responds to voice only',
      visibleInjuries: 'Multiple small penetrating wounds across chest and abdomen',
      mobility: 'Immobile',
      bleeding: 'Oozing from multiple sites',
    },
  },
  {
    trueTag: 'yellow',
    description: 'Compound fracture of femur, significant pain, alert and oriented',
    observableSigns: {
      breathing: 'Normal, slightly elevated',
      pulse: 'Elevated but strong',
      consciousness: 'Alert, in severe pain',
      visibleInjuries: 'Open fracture left femur, bone visible',
      mobility: 'Cannot walk',
      bleeding: 'Controlled with direct pressure',
    },
  },
  {
    trueTag: 'yellow',
    description: 'Second-degree burns to arms and face, airway currently clear',
    observableSigns: {
      breathing: 'Normal',
      pulse: 'Rapid but strong',
      consciousness: 'Alert, distressed',
      visibleInjuries: 'Partial-thickness burns face and both arms, blistering',
      mobility: 'Can walk but unsteady',
      bleeding: 'None',
    },
  },
  {
    trueTag: 'red',
    description:
      'Blast ear injury with severe disorientation, cannot follow commands, head laceration',
    observableSigns: {
      breathing: 'Normal',
      pulse: 'Rapid',
      consciousness: 'Conscious but completely disoriented, cannot respond',
      visibleInjuries: 'Bleeding from both ears, scalp laceration',
      mobility: 'Cannot walk straight',
      bleeding: 'From ears and scalp',
    },
  },
  {
    trueTag: 'yellow',
    description: 'Shrapnel to both legs, multiple wounds, cannot walk but stable',
    observableSigns: {
      breathing: 'Normal',
      pulse: 'Strong, slightly rapid',
      consciousness: 'Alert, cooperative',
      visibleInjuries: 'Multiple fragment wounds both lower legs, no arterial involvement',
      mobility: 'Cannot walk',
      bleeding: 'Controlled oozing from wounds',
    },
  },
  {
    trueTag: 'yellow',
    description: 'Crush injury to hand from falling debris, fractures likely, significant pain',
    observableSigns: {
      breathing: 'Normal',
      pulse: 'Normal',
      consciousness: 'Alert, grimacing',
      visibleInjuries: 'Mangled left hand, likely multiple fractures, deformity',
      mobility: 'Can walk',
      bleeding: 'Moderate from hand',
    },
  },
];

// ── Moderate zone: 40-70m from blast ────────────────────────────────────
const MODERATE_ZONE: VictimPreset[] = [
  {
    trueTag: 'yellow',
    description: 'Hit by flying glass, multiple lacerations to face and neck, one deep',
    observableSigns: {
      breathing: 'Normal',
      pulse: 'Slightly rapid',
      consciousness: 'Alert, anxious',
      visibleInjuries: 'Multiple glass lacerations, one deep wound on neck near carotid',
      mobility: 'Can walk',
      bleeding: 'Moderate from neck wound, minor from face',
    },
  },
  {
    trueTag: 'green',
    description: 'Minor cuts and bruises from falling debris, walking and talking',
    observableSigns: {
      breathing: 'Normal',
      pulse: 'Normal',
      consciousness: 'Alert, shaken',
      visibleInjuries: 'Superficial cuts on arms, bruised shoulder',
      mobility: 'Walking',
      bleeding: 'Minor oozing',
    },
  },
  {
    trueTag: 'green',
    description: 'Blast concussion, ringing ears, disoriented but responsive',
    observableSigns: {
      breathing: 'Normal',
      pulse: 'Slightly rapid',
      consciousness: 'Alert but dazed, slow to respond',
      visibleInjuries: 'No visible injuries, complains of hearing loss and headache',
      mobility: 'Walking unsteadily',
      bleeding: 'None',
    },
  },
  {
    trueTag: 'yellow',
    description: 'Knocked down by blast wave, fractured wrist, possible concussion',
    observableSigns: {
      breathing: 'Normal',
      pulse: 'Normal',
      consciousness: 'Alert, nauseous',
      visibleInjuries: 'Swollen deformed right wrist, abrasions on face',
      mobility: 'Can walk',
      bleeding: 'None',
    },
  },
  {
    trueTag: 'green',
    description: 'Psychological shock, hyperventilating, no physical injuries',
    observableSigns: {
      breathing: 'Rapid, hyperventilating',
      pulse: 'Rapid but strong',
      consciousness: 'Alert but panicking, crying',
      visibleInjuries: 'No visible injuries',
      mobility: 'Walking',
      bleeding: 'None',
    },
  },
];

// ── Peripheral zone: 70m+ from blast ────────────────────────────────────
const PERIPHERAL_ZONE: VictimPreset[] = [
  {
    trueTag: 'green',
    description: 'Minor glass cuts on hands from broken windows',
    observableSigns: {
      breathing: 'Normal',
      pulse: 'Normal',
      consciousness: 'Alert, calm',
      visibleInjuries: 'Superficial cuts on hands and forearms',
      mobility: 'Walking',
      bleeding: 'Minor',
    },
  },
  {
    trueTag: 'green',
    description: 'Temporary hearing loss, ringing in ears, no other injuries',
    observableSigns: {
      breathing: 'Normal',
      pulse: 'Normal',
      consciousness: 'Alert, difficulty hearing',
      visibleInjuries: 'No visible injuries',
      mobility: 'Walking',
      bleeding: 'None',
    },
  },
  {
    trueTag: 'green',
    description: 'Dust inhalation, coughing, eyes irritated but no serious injury',
    observableSigns: {
      breathing: 'Slightly labored, coughing',
      pulse: 'Normal',
      consciousness: 'Alert',
      visibleInjuries: 'Red irritated eyes, dust-covered',
      mobility: 'Walking',
      bleeding: 'None',
    },
  },
  {
    trueTag: 'green',
    description: 'Fell during evacuation, twisted ankle, ambulatory with assistance',
    observableSigns: {
      breathing: 'Normal',
      pulse: 'Normal',
      consciousness: 'Alert, embarrassed',
      visibleInjuries: 'Swollen right ankle',
      mobility: 'Walking with limp',
      bleeding: 'None',
    },
  },
];

// ── Band definitions ────────────────────────────────────────────────────

interface BlastBand {
  maxDistance: number;
  label: string;
  sceneDescription: string;
  presets: VictimPreset[];
  victimCount: [number, number];
}

const BLAST_BANDS: BlastBand[] = [
  {
    maxDistance: 10,
    label: 'Kill Zone',
    sceneDescription:
      'Immediate blast epicenter — catastrophic destruction, unsurvivable injuries.',
    presets: KILL_ZONE,
    victimCount: [3, 4],
  },
  {
    maxDistance: 20,
    label: 'Critical Zone',
    sceneDescription:
      'Near blast seat — severe blast and fragmentation injuries, critical patients requiring immediate intervention.',
    presets: CRITICAL_ZONE,
    victimCount: [4, 5],
  },
  {
    maxDistance: 40,
    label: 'Serious Zone',
    sceneDescription:
      'Moderate blast exposure — shrapnel wounds, fractures, burns. Mix of critical and delayed patients.',
    presets: SERIOUS_ZONE,
    victimCount: [4, 6],
  },
  {
    maxDistance: 70,
    label: 'Moderate Zone',
    sceneDescription:
      'Outer blast effect zone — lacerations from glass, concussions, fractures from falls. Mostly delayed and minor.',
    presets: MODERATE_ZONE,
    victimCount: [3, 5],
  },
  {
    maxDistance: Infinity,
    label: 'Peripheral Zone',
    sceneDescription:
      'Peripheral area — walking wounded, minor cuts, hearing damage, psychological shock.',
    presets: PERIPHERAL_ZONE,
    victimCount: [3, 4],
  },
];

/**
 * Generate casualties appropriate for the given distance from the blast.
 * Victims are sampled from the matching blast band with realistic
 * injury profiles that create a triage challenge within the band.
 */
export function generateBlastCasualties(distanceFromBlast: number): {
  victims: CasualtyVictim[];
  sceneDescription: string;
  bandLabel: string;
} {
  const band =
    BLAST_BANDS.find((b) => distanceFromBlast <= b.maxDistance) ??
    BLAST_BANDS[BLAST_BANDS.length - 1];

  const [minCount, maxCount] = band.victimCount;
  const count = minCount + Math.floor(Math.random() * (maxCount - minCount + 1));

  const shuffled = [...band.presets].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, Math.min(count, shuffled.length));

  // If we need more victims than presets, duplicate with slight variation
  while (selected.length < count && band.presets.length > 0) {
    const extra = band.presets[Math.floor(Math.random() * band.presets.length)];
    selected.push(extra);
  }

  const victims: CasualtyVictim[] = selected.map((p, i) => ({
    id: `v-${Date.now()}-${i}`,
    label: `Victim ${i + 1}`,
    trueTag: p.trueTag,
    description: p.description,
    observableSigns: { ...p.observableSigns },
    imageUrl: null,
    imageGenerating: false,
    playerTag: 'untagged',
    taggedAt: null,
  }));

  return {
    victims,
    sceneDescription: `${band.label} (${Math.round(distanceFromBlast)}m from blast) — ${band.sceneDescription}`,
    bandLabel: band.label,
  };
}
