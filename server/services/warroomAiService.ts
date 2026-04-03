/**
 * War Room AI Service
 * Multi-phase generation: teams+core → time injects → decision injects → locations/seeds.
 * Each phase has its own prompt with explicit schema and fallbacks from templates.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../lib/logger.js';
import type { ThreatProfile } from './warroomPromptParser.js';

// ---------------------------------------------------------------------------
// Inject Pressure Types — 35 granular thematic lenses for inject generation
// ---------------------------------------------------------------------------

export interface InjectPressureType {
  id: string;
  group: string;
  label: string;
  description: string;
  examples: string[];
}

export const INJECT_PRESSURE_TYPES: InjectPressureType[] = [
  // ── Political & Authority ──
  {
    id: 'political_interference',
    group: 'Political & Authority',
    label: 'Political interference',
    description: 'Politicians inserting themselves into operational decisions',
    examples: [
      "A government minister arrives and publicly overrides the incident commander's evacuation plan for political optics",
      'Parliamentary questions are being raised mid-crisis, demanding the IC divert attention to prepare a briefing',
      "The mayor's office issues a contradictory press statement that undermines the operational strategy",
      'A political aide insists on re-routing resources to protect a government building instead of the casualty collection point',
      'A senator demands a personal security detail be pulled from the perimeter cordon',
      'A deputy minister demands the incident be downgraded to avoid embarrassing a visiting foreign delegation',
      'The governor\'s office orders a premature "all clear" press conference while operations are still active',
      'A councillor broadcasts the staging area location on social media to show they are "on scene"',
      'A political party sends volunteers in branded vests to the scene, confusing the public about who is in charge',
      'An election candidate holds a press conference at the cordon blaming the incumbent for inadequate preparedness',
      "The president's advance team demands a security zone for a potential visit, consuming tactical resources",
      'A legislator inserts themselves into casualty notification, contacting families before official channels',
      "A ministry official demands real-time operational updates every 10 minutes, monopolizing the IC's attention",
      'Political staff leak the draft after-action timeline to shape a narrative before the response is complete',
      'A cabinet minister demands that a private hospital be used for VIP casualties instead of the nearest trauma center',
      "The ruling party's communications office rewrites the official incident statement without consulting the IC",
    ],
  },
  {
    id: 'command_chain_conflict',
    group: 'Political & Authority',
    label: 'Command chain conflict',
    description: 'Conflicting orders from competing authority levels',
    examples: [
      "A senior officer who just arrived countermands the acting commander's tactical decisions without situational awareness",
      'The national crisis center issues directives that directly contradict the on-scene operational plan',
      'Two command posts are issuing conflicting orders to the same ground units',
      'A regional commander pulls rank over the local IC via phone, demanding a completely different approach',
      'An off-duty chief arrives and begins giving orders that clash with the established chain of command',
      "A newly promoted supervisor overrides an experienced team leader's decision on cordon placement",
      'The strategic commander and tactical commander disagree on whether to negotiate or breach, paralyzing the response',
      'A headquarters directive mandates a resource allocation that the IC knows will create a gap in coverage',
      'Two colonels from different branches both claim to be the designated military liaison, issuing competing orders',
      'The deputy IC issues a hold order while the IC simultaneously issues an advance order to the same team',
      'A senior fire officer changes the hazard zone classification without consulting the unified command',
      'The night shift commander refuses to hand over to the day shift commander, citing incomplete handover conditions',
      'An admiral observing the exercise intervenes with live tactical guidance that confuses participants',
      'A district commander demands a written risk assessment before authorizing an urgent rescue, delaying action by 20 minutes',
      'The emergency operations center orders a shelter-in-place while the field commander has already begun evacuation',
    ],
  },
  {
    id: 'jurisdictional_turf_war',
    group: 'Political & Authority',
    label: 'Jurisdictional turf war',
    description: 'Agencies fighting over ownership and control',
    examples: [
      'Two agencies both claim ownership of the inner cordon — their officers are giving contradictory directions to the same personnel',
      'A mutual aid request is denied by a neighboring jurisdiction citing resource shortages, but their units are visibly idle nearby',
      'A federal agency deploys assets into the area without notifying local command, causing confusion over who controls what zone',
      'The fire service refuses to enter a sector until police confirms it is "weapons cold" — police says that is fire\'s own assessment to make',
      'A military liaison demands operational control of a sector citing national security jurisdiction',
      'The coast guard and harbor police dispute who has authority over waterway access near the incident',
      'A customs agency blocks a critical supply shipment at the border, insisting on inspection despite the emergency declaration',
      'The national intelligence service confiscates evidence from the scene without informing the lead investigator',
      'Two ambulance services from adjacent districts refuse to cross a boundary line, leaving a gap in medical coverage',
      'The environmental protection agency halts rescue operations in a contaminated area pending its own independent assessment',
      'Airport authority police refuse to allow city police vehicles onto the tarmac, blocking a critical evacuation corridor',
      'A state emergency management agency overrides the local emergency declaration, changing resource allocation protocols',
      'The railway operator denies platform access to emergency responders, citing their own safety procedures',
      'A private security firm contracted by the venue owner clashes with police over who controls internal access points',
      'Counter-terrorism police seal a perimeter that blocks paramedic access, each agency insisting the other must yield',
      'The public health department quarantines an area the fire service needs for staging, neither will compromise',
    ],
  },
  {
    id: 'diplomatic_incident',
    group: 'Political & Authority',
    label: 'Diplomatic incident',
    description: 'Foreign nationals, embassy complications, international pressure',
    examples: [
      'A foreign embassy demands immediate access to their nationals among the casualties, bypassing triage protocols',
      'Diplomatic immunity complicates the detention of a key witness who is a consular official',
      'An international observer team arrives unannounced claiming UN mandate to monitor the response',
      'A foreign government threatens sanctions if their citizens are not prioritized in evacuation',
      'International media are framing the incident as a failure of the host nation, creating geopolitical pressure',
      'A tourist group from a politically sensitive country is among the casualties — their government demands a direct hotline',
      'A foreign intelligence officer embedded among the crowd refuses to identify themselves, complicating the headcount',
      "An allied nation offers military medical assets, but accepting would imply the host nation's capacity is inadequate",
      'A foreign journalist is detained in the restricted zone, and their embassy is threatening trade retaliation',
      "A visiting dignitary's motorcade is caught inside the cordon, and their security detail is refusing to cooperate with local police",
      'A refugee community is among the displaced — their undocumented status is delaying processing at evacuation shelters',
      'A foreign military vessel nearby offers helicopter evacuation, creating a sovereignty complication',
      'An exchange student among the casualties triggers an urgent consular notification that overwhelms the liaison team',
      "A bilateral treaty requires notification of a partner nation's embassy within 30 minutes, but all lines are saturated",
      'A foreign head of state issues a public statement criticizing the response before official channels have been used',
    ],
  },

  // ── Media & Information ──
  {
    id: 'hostile_media_ambush',
    group: 'Media & Information',
    label: 'Hostile media ambush',
    description: 'Journalists confronting commanders, breaching cordons',
    examples: [
      'A journalist confronts the incident commander on live television with footage of delayed ambulance response',
      'A camera crew has bypassed the outer cordon and is filming inside the triage area, broadcasting casualties without consent',
      'Leaked body-camera footage is being broadcast unedited, showing responder mistakes in real time',
      'A news helicopter is hovering low enough to interfere with tactical communications',
      "A reporter publishes the IC's personal mobile number, flooding their phone with media calls",
      'A documentary crew embedded with one team is broadcasting sensitive tactical movements to a live audience',
      'A freelance photographer has climbed onto a rooftop within the hot zone to get exclusive shots, requiring a risky extraction',
      'A reporter broadcasts the location of undercover officers monitoring a suspect vehicle',
      'A media organization files a freedom-of-information request mid-crisis for the command log',
      'A journalist disguised as a paramedic gains access to the casualty clearing station and publishes patient identities',
      'A tabloid sends a drone into the restricted airspace, nearly colliding with a police helicopter',
      "A press conference turns hostile when journalists question the IC's qualifications and demand a replacement",
      'A paparazzi swarm around a celebrity casualty, physically pushing medical staff aside',
      'A foreign news network broadcasts a graphic close-up of a child casualty before family notification',
      'Media vehicles are blocking the ambulance staging area and refuse to move, claiming press freedom',
      'A reporter airs unverified claims of a second device, causing mass secondary evacuation panic',
    ],
  },
  {
    id: 'viral_misinformation',
    group: 'Media & Information',
    label: 'Viral misinformation',
    description: 'Deepfakes, conspiracy theories, false reports spreading',
    examples: [
      'A deepfake video showing a "second explosion" goes viral, triggering mass panic in adjacent neighborhoods',
      'False reports of a chemical attack are circulating on social media, causing hospital ERs to be overwhelmed with worried-well',
      'An AI-generated fake government statement is circulating claiming the area is contaminated',
      'Conspiracy theories blaming a specific community are trending nationally within 30 minutes',
      'A fake emergency alert is sent to phones in the area telling people to shelter in place — contradicting the actual evacuation order',
      'An old photo from a different incident is being shared as live footage, misleading the public about the severity',
      'A manipulated audio clip purporting to be the IC ordering a retreat has been posted, causing confusion among off-duty responders',
      'A fabricated casualty count 10x the actual number is being cited by major outlets before verification',
      'A viral post claims local water is poisoned, triggering panic buying of bottled water and clogging roads',
      'Bot accounts are amplifying a false narrative that the government caused the incident, drowning out official communications',
      'A cloned official social media account is posting fake safety instructions that direct people toward the danger zone',
      'A purported leaked memo claiming the IC was warned weeks ago is circulating, though no such memo exists',
      'An AI-generated voice message imitating the school principal tells parents the school shelter is compromised',
      'Foreign state media broadcasts a fabricated interview with a "survivor" who describes events inconsistent with the actual incident',
      'A hoax bomb threat at a hospital receiving casualties forces a secondary evacuation mid-treatment',
    ],
  },
  {
    id: 'social_media_firestorm',
    group: 'Media & Information',
    label: 'Social media firestorm',
    description: 'Live-streaming, doxxing, crowd-sourced vigilantism',
    examples: [
      "Bystanders are live-streaming the triage area, and a patient's family sees their injured relative on TikTok before being officially notified",
      'A crowd-sourced "investigation" has doxxed the wrong person as the suspect — a mob is forming at their home address',
      'A trending hashtag is blaming a specific agency for slow response, and their headquarters is being protested',
      'An influencer with millions of followers is broadcasting from inside the cordon, drawing more onlookers',
      'Drone footage taken by civilians is revealing tactical positions on social media',
      'A bystander\'s video captures an off-duty responder arguing with a colleague — the clip goes viral, framed as "responders fighting instead of helping"',
      "Online sleuths have identified the wrong vehicle as the suspect's, and people are surrounding it in a shopping mall parking lot",
      'A GoFundMe for a fake victim raises $200K in an hour, diverting attention and donations from legitimate relief',
      'A private Facebook group of parents is organizing a march to the incident site, threatening to overwhelm the perimeter',
      "A meme mocking the IC's appearance during the press conference goes viral, undermining public trust in the response",
      'Multiple live streams of the evacuation are geotagging exact locations, compromising tactical planning',
      "A victim's family member posts a raw emotional video criticizing response time that is shared 100,000 times in 30 minutes",
      'Crowd-sourced radio scanner apps are broadcasting encrypted police communications to the public',
      'A popular podcast host with a large audience begins speculating on air about second suspects, triggering public fear',
      'A hacker collective releases personal data of all deployed officers in solidarity with protest movements, creating safety concerns',
    ],
  },
  {
    id: 'information_blackout',
    group: 'Media & Information',
    label: 'Comms failure / blackout',
    description: 'Cell towers saturated, radio down, coordination collapse',
    examples: [
      'Cell towers in the area are saturated — responders cannot reach hospitals or dispatch by phone',
      'The primary radio repeater has failed; backup frequencies are congested with crosstalk from adjacent jurisdictions',
      'An encrypted channel has been compromised — sensitive tactical information may have been intercepted',
      'The mobile command post has lost all data connectivity; real-time mapping and resource tracking is down',
      "A software update has bricked half the team's handheld radios mid-operation",
      'The fiber optic trunk line serving the area has been physically severed, taking out landlines and internet for the command post',
      'Satellite phone uplinks are failing due to atmospheric conditions, leaving no backup communication method',
      'A power surge destroyed the base station repeater — all trunked radio users are on simplex with limited range',
      'Two agencies are inadvertently operating on the same frequency, causing garbled transmissions and missed messages',
      'The CAD (computer-aided dispatch) system has crashed, and dispatchers are reverting to paper cards for the first time in decades',
      'A critical software token has expired, locking all users out of the interagency coordination platform',
      'WhatsApp groups being used as backup comms have been flagged and temporarily suspended due to unusual traffic volume',
      "The incident commander's radio has failed, and the backup radio battery is dead — they are physically running between positions",
      'A jammer is suspected near the scene; all wireless signals within 500m are degraded',
      'The emergency paging system used to recall off-duty staff has failed, delaying reinforcement by over an hour',
      'The backup generator at the comms tower ran out of fuel — the tower is now offline and cannot be refueled due to road closures',
    ],
  },

  // ── Community & Social ──
  {
    id: 'ethnic_religious_tension',
    group: 'Community & Social',
    label: 'Ethnic or religious tension',
    description: 'Communal blame, sectarian conflict, racial accusations',
    examples: [
      'A mob is accusing members of a specific ethnic group of being responsible, surrounding their vehicles and blocking them',
      'Sectarian graffiti has appeared on the venue walls during the response, escalating communal tension',
      'Community leaders from two rival groups are confronting each other at the assembly point, drawing in bystanders',
      'A religious leader is publicly blaming a minority community, and the speech is being broadcast live',
      'Physical confrontations are breaking out between ethnic groups near the evacuation route',
      'A neighborhood with a history of communal violence is seeing retaliatory property damage in response to the incident',
      'A prominent imam and a pastor are in a public argument about blame, drawing a crowd that is blocking the access road',
      'Taxi drivers of a particular ethnicity are refusing to transport evacuees from the opposing community',
      'An extremist group distributes leaflets at the evacuation center blaming the minority population',
      'A vigil organized by one community is confronted by counter-protesters, requiring police to divert from the incident',
      'Residents are reporting hate crimes in adjacent neighborhoods as tensions spill over from the incident zone',
      "Social media posts targeting a community's place of worship have been reported, requiring protective police deployment",
      'Community elders are demanding a meeting with the IC before cooperating with evacuation, delaying operations',
      'A fight breaks out at the family reunification center between families of different ethnic backgrounds over queue priority',
      'A racial profiling accusation against checkpoint officers goes viral, complicating public cooperation with the cordon',
    ],
  },
  {
    id: 'vigilante_behavior',
    group: 'Community & Social',
    label: 'Vigilante behavior',
    description: 'Armed citizens, mob justice, self-appointed patrols',
    examples: [
      'Armed civilians are "patrolling" the perimeter and confronting anyone who looks like the suspect description',
      'A crowd has seized a person they believe is an accomplice and is refusing to hand them over to police',
      'A neighborhood watch group has set up an unauthorized checkpoint, blocking an evacuation route',
      'Vigilantes have surrounded a vehicle matching a suspect description — the occupants are terrified bystanders',
      'A group is threatening to storm the restricted zone to "handle the situation themselves"',
      'A martial arts school has deployed its members to "protect" the community center, turning away emergency responders',
      "Shop owners along the main street have armed themselves with improvised weapons, threatening anyone they don't recognize",
      'A retired military group is conducting their own "search operation" in the area, confusing witnesses and contaminating leads',
      'An anonymous online group posts the home addresses of people they claim are accomplices, inciting in-person harassment',
      "Taxi drivers form a blockade around the suspect's reported neighborhood, trapping innocent residents inside",
      'A father of a victim has obtained a weapon and is heading to the last reported suspect location',
      'A private security company has deployed armed guards around a business cluster without police coordination',
      'A citizen with a licensed firearm confronts a plainclothes detective at a checkpoint, mistaking them for a threat',
      "A crowd has set a suspect's abandoned vehicle on fire, destroying potential forensic evidence",
      'Volunteers from a local gym have created a human chain around the perimeter, refusing to let anyone they deem suspicious pass',
      'An ex-police officer who was dismissed for misconduct has inserted themselves into the cordon operation, giving false orders',
    ],
  },
  {
    id: 'cultural_sensitivity',
    group: 'Community & Social',
    label: 'Cultural sensitivity clash',
    description: 'Body handling conflicts, religious customs vs protocols',
    examples: [
      'A religious community objects to how bodies are being handled, demanding rites be performed before any are moved',
      'Prayer time has begun and a group insists on completing prayers despite mandatory evacuation orders',
      "Dietary and medical customs are conflicting with triage protocols — a patient's family refuses a blood transfusion",
      'A cultural leader demands gender-segregated evacuation routes, which would split the available exits',
      'Traditional mourning practices are blocking vehicle access to the casualty collection point',
      "A Sikh family insists their injured relative's turban not be removed during medical treatment, creating a clinical dilemma",
      'An indigenous elder demands permission to perform a cleansing ceremony before anyone enters the site',
      'Kosher food requirements at the evacuation shelter cannot be met, and a group is refusing to eat or cooperate',
      'A Hindu family refuses to allow their deceased relative into a body bag, demanding immediate cremation arrangements',
      'Female casualties from a conservative community refuse treatment from male paramedics, but no female medics are available',
      'A Buddhist monk is meditating in the evacuation path and followers are forming a protective circle around them',
      'Ramadan fasting is affecting the stamina of several volunteers and evacuees, but they refuse water or food',
      'A community demands that their dead be returned within 24 hours per religious requirement, conflicting with forensic timelines',
      'A traditional healer is offering alternative treatments to casualties, creating confusion about their medical status',
      'The evacuation shelter is co-located with a venue serving alcohol, which a religious group finds deeply offensive — they refuse entry',
    ],
  },
  {
    id: 'language_barrier',
    group: 'Community & Social',
    label: 'Language barrier crisis',
    description: 'Miscommunication, wrongful detention, lost in translation',
    examples: [
      "A non-English-speaking family has been detained as suspects because they couldn't explain why they were running",
      'A critical eyewitness can only speak a rare dialect — no interpreter is available and their account is time-sensitive',
      'Evacuation instructions are not reaching a large group of foreign workers who speak neither English nor the local language',
      "Medical consent cannot be obtained for an unconscious child because the parents don't speak the triage team's language",
      'A mistranslated radio message has sent a team to the wrong building',
      'A deaf evacuee is unable to understand verbal commands and is being forcibly restrained by officers who misinterpret resistance',
      'Sign language interpreters are unavailable, leaving 15 hearing-impaired evacuees unable to receive safety briefings',
      'A tourist group speaking Mandarin has been misdirected into the hot zone because no one could read the signs in their language',
      'An Arabic-speaking witness is providing critical intelligence but the translator is making significant errors under pressure',
      'Written evacuation signage is only in the national language, leaving migrant workers unable to find exit routes',
      'A Somali-speaking mother is separated from her child and cannot describe the child to reunification staff',
      'A phone translation app is producing dangerously wrong medical terms, leading to an incorrect triage classification',
      'A Vietnamese fishing crew docked nearby cannot understand why they are being ordered to leave and are becoming agitated',
      'A Roma community in the area distrusts authorities and will only communicate through a specific community elder who has not been located',
      'An international conference was in session — 200 attendees speak 30+ languages and no coordinated translation capacity exists',
    ],
  },

  // ── Human & Emotional ──
  {
    id: 'family_intrusion',
    group: 'Human & Emotional',
    label: 'Family intrusion',
    description: 'Distraught families storming restricted areas',
    examples: [
      'Parents have breached the inner cordon and are searching the rubble for their children, interfering with rescue operations',
      'A family is physically blocking an ambulance from leaving, demanding to know if their relative is inside',
      'Relatives of a VIP are leveraging political connections to gain access to the restricted treatment area',
      'A group of families has occupied the command post entrance demanding information, blocking staff movement',
      'A mother has collapsed at the family reunification point and her other children are now unattended in the evacuation zone',
      'A father is scaling a fence into the hot zone to reach his trapped daughter — officers must decide whether to use force',
      'An elderly couple has wandered past the cordon searching for their grandchild and cannot be located',
      'A family has brought a solicitor who is threatening legal action if they are not given access to the treatment area',
      'Three separate families are arguing at the reunification desk, each claiming the same unidentified child is theirs',
      'A large extended family has arrived in 12 vehicles, overwhelming the designated parking area and blocking emergency access',
      "A relative is refusing to leave a deceased family member's side, physically clinging to the body as forensics team waits",
      'A teenager has escaped from the family holding area and run back toward the incident site looking for their sibling',
      'Families are pooling money to hire a private helicopter to fly over the scene, creating an airspace conflict',
      "A parent who is also an off-duty nurse is demanding to treat their own child, overriding the triage doctor's decisions",
      'A family has contacted a private ambulance service to extract their relative, bypassing the medical chain',
      "Siblings of a missing person are posting the triage area's exact location online, inviting more families to arrive",
    ],
  },
  {
    id: 'vip_privilege',
    group: 'Human & Emotional',
    label: 'VIP demanding privilege',
    description: 'Rank-pulling, priority demands, entourage disruption',
    examples: [
      "A politician's aide demands their principal be evacuated first, threatening career consequences for the IC",
      'A corporate executive whose company owns the venue is pulling rank, insisting on access to assess property damage during active operations',
      "A celebrity's entourage has created a secondary crowd, drawing resources away from the incident",
      'A military general in civilian clothes demands to jump the triage queue for a minor injury, citing rank',
      'A wealthy donor to the police benevolent fund is calling the commissioner to demand special treatment',
      'A tech billionaire offers to fly in private medical resources but demands control over where they are deployed',
      'A retired supreme court justice refuses to evacuate via the standard route, insisting on a private escort',
      "A professional athlete's agent is demanding a private ambulance, threatening to sue if the athlete waits in triage",
      'The owner of a major media group implies favorable coverage in exchange for priority access to the scene',
      "An ambassador's spouse demands a helicopter extraction, citing diplomatic privilege for a non-emergency injury",
      "A CEO insists their company's private fire suppression team be allowed to operate independently inside the cordon",
      'A socialite is live-streaming their evacuation experience, attracting a crowd that impedes the exit corridor',
      'A retired general who sits on the emergency management board phones the IC demanding a personal briefing every 15 minutes',
      'A wealthy industrialist offers a large donation contingent on their warehouse being prioritized for protection over residential areas',
      'A minor royal demands a personal police escort through the restricted zone to retrieve personal belongings from a vehicle',
    ],
  },
  {
    id: 'mass_grief_event',
    group: 'Human & Emotional',
    label: 'Mass grief event',
    description: 'Collective emotional breakdown, memorial disruption',
    examples: [
      'A collective emotional breakdown at the family reunification point is overwhelming the welfare team',
      'A spontaneous memorial gathering is blocking a critical access road and growing rapidly',
      'Grief-driven aggression is escalating — bereaved family members are physically attacking responders they blame for delay',
      'A group of survivors is refusing to leave the scene, sitting down in the evacuation path in shock',
      "A children's school group was at the venue — dozens of parents are arriving simultaneously in states of panic",
      'A candlelight vigil has ignited decorations on the memorial, creating a small fire near the perimeter',
      'Hundreds of people are gathering outside the hospital demanding to see patient lists, blocking the emergency entrance',
      'A community choir has begun singing hymns at the cordon, drawing a massive crowd that is blocking the access road',
      'A grief counselor has themselves become overwhelmed and is now in need of treatment, leaving the team short-staffed',
      'A school bus of children who witnessed the incident has arrived at the staging area — none have been collected by parents',
      'A suicide note referencing the incident is found on social media, requiring immediate welfare check deployment',
      'Memorial flowers and teddy bears are accumulating so rapidly at the scene entrance that they are physically blocking the gate',
      'A flashmob organized online to "honor the victims" arrives at the staging area with 500 participants',
      'Several survivors are experiencing acute dissociative episodes, walking silently back toward the danger zone',
      'A pregnant woman goes into premature labor at the family reunification center, triggered by the stress of the event',
    ],
  },
  {
    id: 'ethical_dilemma',
    group: 'Human & Emotional',
    label: 'Ethical dilemma',
    description: 'Moral choices in triage, treatment refusal, evidence vs lives',
    examples: [
      'A patient is refusing life-saving treatment on religious grounds, but their family is begging the team to override the refusal',
      'The triage team must choose between treating a critical child and a responder who can return to duty if stabilized',
      'Forensic evidence critical to identifying the perpetrator is in a zone where casualties are still trapped — collecting evidence would delay rescue',
      'A DNR-carrying patient is in cardiac arrest but their distressed family is demanding full resuscitation',
      'Two casualties need the last unit of O-negative blood — one is a child, the other is a pregnant woman',
      'A suspected accomplice is critically injured — medics must decide whether to prioritize treatment or allow police to interrogate first',
      "An organ donor card is found on a dying patient whose organs could save three others, but the family hasn't been consulted",
      'A triage decision downgrades a young mother to expectant (likely fatal) category — her husband witnesses and protests',
      "Treating a contaminated casualty without full PPE could save their life but risks the medic's health",
      'Releasing unverified casualty names could help families but may cause harm if identities are wrong',
      'A service animal is trapped alongside its owner — rescuing the animal would delay extraction of a second human casualty',
      'An undocumented immigrant is dying but refuses hospital transport for fear of deportation upon identification',
      'A child is trapped with a deceased parent — rescuers must decide whether to remove the body in front of the child or delay extraction',
      'A journalist offers footage of the suspect in exchange for exclusive triage area access — the footage could save lives',
      'An experimental drug could stabilize a critical patient but has not been approved — the medical director must decide immediately',
      'Water supplies are running low; the team must choose between hydrating exhausted responders or heat-stressed evacuees',
    ],
  },
  {
    id: 'mental_health_crisis',
    group: 'Human & Emotional',
    label: 'Mental health crisis',
    description: 'Responder breakdown, survivor self-harm, PTSD escalation',
    examples: [
      'A senior responder has had a psychological breakdown mid-operation and is sitting unresponsive in the command vehicle',
      'A survivor is threatening self-harm on a rooftop overlooking the incident zone, diverting tactical resources',
      'A PTSD-triggered veteran among the bystanders has escalated a confrontation with police into a standoff',
      'Multiple responders are showing signs of acute stress after discovering child casualties, impacting operational capacity',
      'A triage nurse has frozen and cannot continue treating patients after recognizing a victim as a personal acquaintance',
      'An evacuee who lost their medication during the incident is having a severe psychiatric episode at the shelter',
      'A firefighter refuses to enter a structure, revealing they have undiagnosed claustrophobia triggered by the conditions',
      'A cordon officer is found crying behind a vehicle and admits they are having suicidal thoughts',
      'A survivor with pre-existing PTSD has barricaded themselves in a bathroom and is screaming, terrifying other evacuees',
      'A child witness has gone completely nonverbal and catatonic — standard pediatric protocols are not working',
      'A paramedic is self-medicating with alcohol found at the venue to cope with the stress, and is now impaired',
      'A volunteer who witnessed the initial attack is compulsively returning to the scene, unable to stop reliving the moment',
      'The peer support officer is overwhelmed by demand — 8 responders have requested immediate psychological support simultaneously',
      'A crisis negotiator called to talk down a suicidal survivor discovers they know the person personally',
      'A group of survivors is displaying mass psychogenic illness, all reporting symptoms with no physical cause',
    ],
  },

  // ── Infrastructure & Technical ──
  {
    id: 'power_grid_failure',
    group: 'Infrastructure & Technical',
    label: 'Power grid failure',
    description: 'Generators failing, gridlock, elevator entrapments',
    examples: [
      "The venue's backup generators have failed — the triage area has lost lighting and powered medical equipment",
      'Traffic signals in a 2km radius are dead, creating gridlock that is blocking ambulance access routes',
      'Elevator entrapments in adjacent buildings are diverting fire crews away from the primary incident',
      'The mobile command post is running on battery and will lose all systems within 30 minutes',
      'Street lighting failure is making the nighttime perimeter impossible to secure visually',
      "The hospital's intensive care unit has switched to emergency power, which cannot sustain all ventilators — triage of ICU patients begins",
      'A transformer explosion near the staging area injures two responders and knocks out remaining power',
      'Refrigerated mortuary facilities have lost power, creating a biological hazard from unpreserved remains',
      'The electric vehicle ambulances cannot be recharged — they will be inoperable within 2 hours',
      'Security cameras and automated door locks across the venue have failed, creating uncontrolled access points',
      'The sewage pumping station has lost power, and raw sewage is backing up into the underground car park being used as a shelter',
      'Emergency lighting in the stairwells has expired, making vertical evacuation of a high-rise building impossible in darkness',
      'A substation fire threatens to cascade into a wider blackout affecting three hospitals in the region',
      'The water treatment plant is on backup power with 4 hours of fuel — if it fails, the city loses safe water supply',
      'Solar panels damaged in the incident are creating an electrocution hazard, blocking access to an area with trapped casualties',
    ],
  },
  {
    id: 'water_contamination',
    group: 'Infrastructure & Technical',
    label: 'Water or utility disruption',
    description: 'Burst mains, gas leaks, sewage backup',
    examples: [
      'A burst water main is flooding the primary evacuation route with 30cm of water, making it impassable for stretchers',
      'A gas leak has been detected in the adjacent building, forcing a secondary evacuation of the staging area',
      'Sewage backup in the designated shelter is creating a biohazard, requiring relocation of 200 evacuees',
      'The fire hydrant system has lost pressure — fire suppression in the affected building is no longer possible',
      'Water supply to the decontamination station has been cut, halting all patient decon processing',
      'A broken steam pipe is venting scalding water into the pedestrian underpass being used as a triage corridor',
      'Gas utility workers insist on isolating the gas supply to the entire block, which would cut heating to the evacuation shelter in freezing conditions',
      'The water main break has created a sinkhole that has swallowed a parked ambulance',
      'Contaminated water from the incident site has entered the storm drain system and is flowing toward a public waterway',
      'A sewer main collapse has undermined the road surface near the command post — vehicles are at risk of falling through',
      "The building's sprinkler system has activated on undamaged floors, soaking evidence and creating slip hazards",
      'A natural gas pocket exposed by structural damage is accumulating in a basement where casualties are sheltering',
      'The fire suppression foam system has activated unexpectedly, filling corridors with dense foam and disorienting evacuees',
      'A chilled water pipe burst in the server room is destroying communications equipment critical to the operation',
      'Underground utility mapping is inaccurate — a digging operation to free a trapped person has struck a live water line',
    ],
  },
  {
    id: 'cyber_attack',
    group: 'Infrastructure & Technical',
    label: 'Cyber attack',
    description: 'GPS spoofing, ransomware, spoofed transmissions',
    examples: [
      'GPS spoofing is misdirecting ambulances to a location 3km from the actual incident site',
      "Ransomware has locked the receiving hospital's patient records system — they cannot check allergies or medical histories",
      'Spoofed radio transmissions mimicking the IC\'s voice are giving false "all clear" orders to perimeter teams',
      'The CCTV network has been hacked — all cameras show looped footage from before the incident',
      'A DDoS attack has taken down the emergency dispatch system, forcing manual coordination by phone',
      'Traffic management systems have been compromised — green lights on all approaches are creating dangerous intersections',
      'The public alert system has been hijacked and is sending false evacuation orders to the wrong areas',
      'Phishing emails impersonating the emergency management agency are being sent to responders asking for credentials',
      'The building access control system has been locked by ransomware — all fire doors are sealed shut with people inside',
      'Drone command frequencies are being jammed, grounding all aerial surveillance assets',
      'A social engineering attack has tricked a dispatcher into revealing the tactical operations center location',
      "The hospital's medication dispensing system is offline — pharmacists must manually verify all drug interactions",
      'Smart building sensors have been spoofed to report normal air quality in a contaminated zone',
      'An insider has planted a USB device in the command post that is exfiltrating data in real time',
      'The online patient tracking system shows false casualty locations, sending family members to the wrong hospitals',
      'Navigation apps have been fed false road closure data, routing thousands of civilian vehicles through the response corridor',
    ],
  },
  {
    id: 'transport_collapse',
    group: 'Infrastructure & Technical',
    label: 'Transport network collapse',
    description: 'Bridge closures, rail shutdown, highway blockage',
    examples: [
      'The only bridge connecting the incident zone to the main hospital has been closed due to structural concerns',
      'A rail shutdown has stranded 500 evacuees at a transit station with no bus alternative available',
      'A highway pileup triggered by rubberneckers is blocking all western approach routes for emergency vehicles',
      'Public transit drivers are refusing to operate routes near the incident zone, stranding evacuees',
      'A fuel tanker has overturned on the main access road, requiring a hazmat team and closing the route for hours',
      "The airport has suspended departures, stranding thousands of passengers who are now converging on the city's hotels and shelters",
      'A tunnel closure due to safety checks has eliminated the primary underground route, adding 40 minutes to ambulance journeys',
      'Ride-share services have imposed surge pricing of 10x, making it impossible for evacuees without cars to leave the area',
      'A freight train derailment is blocking three level crossings that are critical emergency access routes',
      'The ferry terminal has suspended service due to falling debris risk, cutting off an island community from the mainland',
      'Automated bollards around the pedestrian zone have malfunctioned in the raised position, blocking ambulance access',
      'A protest march organized in response to the incident is blocking a 6-lane highway leading to the staging area',
      'The parking structure closest to the incident has been condemned, trapping 300 vehicles belonging to evacuees inside',
      'A helicopter landing zone was set up on a highway, but police cannot keep civilian vehicles off the closed section',
      'Shipping containers have fallen from a port gantry onto the arterial road, creating an impassable blockage',
    ],
  },
  {
    id: 'structural_collapse',
    group: 'Infrastructure & Technical',
    label: 'Structural collapse risk',
    description: 'Building integrity failure, progressive collapse threat',
    examples: [
      'Structural engineers report the damaged building shows signs of progressive collapse — all teams inside must withdraw immediately',
      'A parking garage adjacent to the staging area is cracking under the weight of emergency vehicles',
      'A construction crane damaged by the blast is swaying over the incident zone, threatening a secondary collapse',
      'The floor of the triage area (a convention hall) is showing signs of deflection under the weight of equipment and patients',
      'Aftershock tremors (or secondary detonation vibrations) are destabilizing already-damaged structures',
      'A glass curtain wall on an adjacent tower is shattering intermittently, raining shards on the staging area below',
      'The roof of the evacuation shelter is sagging after accumulating water from firefighting operations',
      'A retaining wall separating the incident site from a lower road is showing lateral displacement',
      'A pedestrian overpass above the access route is rated as unsafe — but it is the only route for stretcher teams',
      'Underground voids detected by sonar suggest the area beneath the command post is at risk of subsidence',
      'A heritage building with unreinforced masonry walls is leaning 3 degrees off vertical, threatening the evacuation corridor',
      'The expansion joints in a multi-story car park are widening — structural failure could pancake all floors',
      'A scaffolding structure on a nearby construction site has partially collapsed and is hanging over the street',
      'Vibrations from heavy rescue vehicles are accelerating crack propagation in the damaged building facade',
      'The basement level of the affected building is flooding, weakening the foundations and accelerating structural degradation',
    ],
  },

  // ── Environmental & Hazards ──
  {
    id: 'weather_escalation',
    group: 'Environmental & Hazards',
    label: 'Weather escalation',
    description: 'Wind shift, rain, temperature extremes affecting operations',
    examples: [
      'A wind shift is blowing smoke and toxic fumes directly toward the triage area, requiring immediate relocation',
      'A sudden downpour has flooded the staging area and is causing hypothermia risk for exposed casualties',
      'A temperature drop below freezing is threatening hypothermia for casualties awaiting transport — blankets and heating are insufficient',
      'Lightning is striking within 1km, forcing suspension of all outdoor helicopter operations',
      'Fog has reduced visibility to 20 meters, making perimeter control and navigation nearly impossible',
      'Extreme heat (42°C) is causing heat exhaustion in responders wearing full PPE, requiring mandatory rotation every 20 minutes',
      'A dust storm is reducing visibility and contaminating open wounds in the outdoor triage area',
      'High winds are grounding drone surveillance and making it impossible to secure tarpaulins over the casualty collection point',
      'A hailstorm is injuring people in open areas and damaging vehicle windshields, creating additional casualties',
      'Heavy snowfall has made road surfaces impassable for standard ambulances — only 4WD vehicles can move',
      'A tornado warning has been issued for the area — all outdoor operations must be suspended and teams sheltered',
      'UV index is extreme and fair-skinned evacuees in the holding area are developing sunburn after 90 minutes of exposure',
      'Rising humidity is causing fogging of all optical equipment including night-vision and thermal cameras',
      'Tidal surge is forecast to reach the low-lying staging area within 2 hours, requiring preemptive relocation',
      'A microburst has toppled temporary structures at the staging area, injuring three responders',
    ],
  },
  {
    id: 'hazmat_discovery',
    group: 'Environmental & Hazards',
    label: 'Secondary hazmat discovery',
    description: 'Chemical leaks, asbestos, unknown powders',
    examples: [
      'A chemical storage room near the incident has been breached — unknown substances are leaking into the building',
      'Structural damage has exposed asbestos insulation, contaminating the air in the rescue zone',
      'An unknown white powder has been discovered in a room adjacent to the blast site, requiring a CBRN team assessment',
      'Industrial chemicals from a rooftop HVAC system are dripping into the evacuation stairwell',
      'Water used for fire suppression has mixed with hazardous materials, creating a toxic runoff flowing toward the public area',
      'A laboratory in the building contained radioactive calibration sources — two are unaccounted for in the debris',
      'Mercury from smashed thermometers in a medical supply room has pooled on the floor of the evacuation route',
      'A pesticide storage shed in the adjacent property has ruptured, releasing organophosphate vapors',
      'Lead paint dust from demolished historic walls is creating an inhalation hazard in the rescue zone',
      'A dry-cleaning business in the affected building contained perchloroethylene — the solvent is evaporating into the air',
      'Battery acid from a destroyed UPS room is leaking through the floor onto rescue workers below',
      'A university research lab in the building contained cultures of non-pathogenic bacteria — but containment cannot be confirmed',
      'Formaldehyde from a damaged medical supply area is causing eye and respiratory irritation among rescuers',
      'Pool chemicals from a leisure center have mixed due to structural damage, generating chlorine gas',
      'An art studio contained solvents and fixatives that are now aerosolized in the damaged section of the building',
      'A pharmacy in the affected area has been breached — controlled substances are scattered and must be secured',
    ],
  },
  {
    id: 'fire_spread',
    group: 'Environmental & Hazards',
    label: 'Fire spread',
    description: 'Secondary fires, approaching wildfire, fuel storage threat',
    examples: [
      'Secondary fires from damaged gas lines are spreading to adjacent structures, threatening the evacuation route',
      'A wildfire approaching from adjacent bushland is generating smoke that is degrading air quality across the entire site',
      "A vehicle fire in the underground parking structure is threatening the building's fuel storage tanks",
      'Electrical fires are breaking out on multiple floors due to water damage to wiring',
      "The fire has reached a commercial kitchen's gas supply — an explosion risk is imminent in the north wing",
      'A tire storage facility adjacent to the scene has ignited, producing dense toxic black smoke that is blanketing the area',
      'Embers from the primary fire have ignited the roof of the evacuation shelter 200m downwind',
      'A lithium battery storage room in the building is in thermal runaway — water cannot be used to extinguish it',
      'Vegetation between the incident site and a residential neighborhood has caught fire, forcing a secondary evacuation',
      'An underground cable fire is producing smoke that is venting through manholes along the main evacuation route',
      'Paint and lacquer supplies in a hardware store are fueling an intensifying fire that threatens to jump the firebreak',
      "The building's cladding material is highly flammable — fire is racing up the exterior faster than internal floors can be evacuated",
      "A fuel truck parked at the venue's loading dock is within the fire spread zone — if its tank breaches, a BLEVE is possible",
      'Grease trap fires in the food court are generating flashover conditions, cutting off a secondary exit',
      'A rooftop solar installation is preventing firefighters from venting the roof, trapping superheated gases inside',
    ],
  },
  {
    id: 'environmental_cascade',
    group: 'Environmental & Hazards',
    label: 'Environmental cascade',
    description: 'Landslides, flooding, toxic runoff chain reactions',
    examples: [
      'A landslide triggered by the explosion has blocked the only alternate access route to the venue',
      'Upstream dam release is sending a flood surge that will reach the low-lying staging area within 45 minutes',
      'Toxic runoff from the incident site has entered the municipal water supply intake, triggering a city-wide water advisory',
      'The vibrations have disturbed a wasp nest colony in the adjacent parkland — swarms are disrupting the outdoor triage area',
      'Soil liquefaction from water main damage is causing ground subsidence under the command post',
      'A coastal storm surge coincides with the incident, flooding basement areas where casualties are sheltering',
      'Smoke from the fire has triggered a respiratory health emergency in a nearby asthma-prone neighborhood',
      'An avalanche warning has been issued for the mountain above the incident site, threatening the only access road',
      'Contaminated surface water has killed fish in a nearby stream, drawing environmental protesters to the perimeter',
      'A sinkhole has opened in the parking area, swallowing two response vehicles and their equipment',
      'High winds are spreading debris and contaminated dust over a 3km area, expanding the evacuation zone significantly',
      'A bridge weakened by flooding upstream is now the only remaining access route — load restrictions are in effect',
      'Falling tree limbs from heat-stressed trees are creating hazards in the staging area and along access routes',
      'An animal enclosure at a nearby facility has been breached — escaped animals are in the response area',
      'Rising groundwater from recent rainfall is flooding the basement command center from below',
    ],
  },

  // ── Operational & Supply ──
  {
    id: 'supply_chain_disruption',
    group: 'Operational & Supply',
    label: 'Supply chain disruption',
    description: 'Ambulance delays, missing supplies, vendor failures',
    examples: [
      'The ambulance fleet has been delayed by a protest blockade on the main highway, with no ETA for clearance',
      'A blood bank shipment was destroyed in a traffic accident en route — the nearest alternative supply is 90 minutes away',
      'Critical medication needed for nerve agent exposure treatment is on nationwide backorder',
      'The contracted catering company for the evacuation shelter has refused to deliver, citing safety concerns',
      'Medical supply pallets delivered to the staging area contain the wrong items — someone sent surgical supplies instead of trauma kits',
      'The oxygen cylinder resupply truck has broken down — current supplies at the triage point will be exhausted in 45 minutes',
      'Body bags have run out and the mortuary service provider is not answering calls',
      'The portable toilet provider for the evacuation center cannot deliver for 6 hours — sanitation is becoming critical',
      'IV fluid stocks at the casualty clearing station are running low and the next delivery is diverted to another incident',
      'A fuel shortage means response vehicles are beginning to run dry — no fuel bowser is available',
      'PPE stockpiles have been depleted faster than anticipated due to a contamination false alarm requiring full suit-up',
      'The mobile medical unit was dispatched to the wrong address and is now stuck in traffic trying to redirect',
      'Water tankers meant for the decontamination line were commandeered by the fire service for fire suppression',
      'Stretchers are exhausted — casualties are being transported on doors and improvised carries',
      'The helicopter rescue service reports a maintenance issue — their aircraft is grounded indefinitely',
      'Donated supplies from the public are arriving unsorted at the staging area, blocking organized logistics',
    ],
  },
  {
    id: 'hospital_overflow',
    group: 'Operational & Supply',
    label: 'Hospital capacity overflow',
    description: 'Trauma centers on divert, receiving facilities refusing patients',
    examples: [
      'All Level 1 trauma centers within 30km have declared divert — the nearest accepting facility is 45 minutes away',
      'The primary receiving hospital has activated its own mass casualty protocol and is refusing additional patients',
      "The pediatric ICU at the children's hospital is at capacity and is turning away critical pediatric casualties",
      'A hospital is threatening to refuse patients because responders are not following their admission protocols',
      'The burn unit that accepted the first wave of patients has run out of skin grafting supplies and is downgrading to stabilize-only',
      'Emergency departments are being overwhelmed by worried-well patients, reducing capacity for actual casualties',
      'A hospital has declared an internal emergency — a power failure has forced them to ventilate patients manually',
      'Psychiatric beds across the region are full, leaving acutely distressed survivors with no inpatient care option',
      'The hospital blood bank has depleted all O-negative stock and is issuing urgent appeals that are clogging radio channels',
      'Operating theaters are backed up with a 4-hour surgical wait — critical patients are deteriorating in holding',
      'A hospital nearby is undergoing renovation — half its wards are physically inaccessible, halving its effective capacity',
      'The regional trauma network coordinator reports that all helicopter-capable landing pads at nearby hospitals are occupied',
      'A maternity ward in the receiving hospital must be partially evacuated to make space, displacing vulnerable patients',
      "The hospital's triage area is overflowing into the parking lot, creating exposure and security concerns",
      'Medical staff at the nearest hospital are staging a work-to-rule action over safety concerns, slowing patient processing',
    ],
  },
  {
    id: 'personnel_attrition',
    group: 'Operational & Supply',
    label: 'Personnel fatigue / attrition',
    description: 'Exhaustion, relief teams delayed, key specialists lost',
    examples: [
      'The shift commander has collapsed from exhaustion after 14 hours on scene and must be replaced immediately',
      'The relief team is stuck in traffic caused by the transport network failure — ETA unknown',
      'The only CBRN specialist on scene has been called away to a second suspected chemical incident across the city',
      'Three paramedics have reported feeling symptomatic after treating contaminated patients without adequate PPE',
      "The K-9 search team's dogs are exhausted and dehydrated — no replacement teams are available for 4 hours",
      'The bomb disposal officer has exceeded their maximum consecutive duty hours and regulations require a mandatory stand-down',
      'A team leader has been quietly self-treating a worsening injury rather than reporting it — they have now collapsed',
      'Half the night shift called in sick with food poisoning from a catered meal at the station',
      'The coroner has reached their legal maximum caseload and cannot certify any more deaths until a second coroner arrives',
      'A key bilingual officer who was handling all interpreter duties has gone off shift with no replacement',
      'The helicopter pilot has reached their maximum flight hours and must ground the aircraft with no relief pilot available',
      'Volunteer fatigue is setting in — 60% of the volunteer contingent has left without formal release',
      'The only pediatric trauma surgeon in the region is already in surgery with the first casualties — no one else is qualified',
      'An entire fire crew has been stood down after exposure to an unknown substance, pending medical clearance',
      'The logistics officer has been awake for 22 hours and is making increasingly erratic resource allocation decisions',
    ],
  },
  {
    id: 'equipment_malfunction',
    group: 'Operational & Supply',
    label: 'Equipment malfunction',
    description: 'Critical gear failing, no replacements available',
    examples: [
      'The decontamination shower unit has malfunctioned — contaminated patients cannot be processed',
      'Radio batteries are dying across multiple teams with no replacement stock at the staging area',
      'The thermal imaging camera is producing false readings due to heat from nearby fires, misleading the search team',
      "The mobile hospital's ventilator has failed mid-patient — the backup unit is incompatible with the patient's intubation",
      'The incident command software has crashed and will not restart, losing all resource tracking data',
      "The jaws of life have seized during an extraction — the trapped casualty's condition is deteriorating",
      'An air monitoring device is giving inconsistent readings, creating uncertainty about whether the area is safe to enter',
      'The portable X-ray machine has malfunctioned — blast injury patients cannot be assessed for internal shrapnel',
      'The public address system has failed — evacuation announcements cannot reach the upper floors',
      "A ladder truck's hydraulic system has failed while extended, stranding two firefighters at height",
      'The satellite communications terminal has a hardware failure — the only link to national command is down',
      "Hazmat suit integrity has been compromised on two team members' suits — they must withdraw from the contaminated zone",
      'The fire suppression foam proportioner is mixing incorrectly, making the foam ineffective against the chemical fire',
      'The automated external defibrillators in the staging area have expired certification — liability concerns halt their use',
      'The crime scene 3D scanner has malfunctioned, meaning forensic evidence capture must be done manually with photographs',
      'A generator powering the field lighting has overheated and shut down, plunging the nighttime scene into darkness',
    ],
  },

  // ── Trust & Insider ──
  {
    id: 'impersonation',
    group: 'Trust & Insider',
    label: 'Credential fraud / impersonation',
    description: 'Fake professionals, stolen uniforms, unauthorized access',
    examples: [
      'A person wearing stolen medical scrubs has been treating patients in the triage area — their qualifications are unknown',
      'An unauthorized individual claiming to be a government inspector has gained access to the command post and has been photographing operational plans',
      'A stolen ambulance with fake markings has entered the restricted zone and its occupants are unaccounted for',
      'Someone impersonating a structural engineer has told teams to evacuate a building that is actually safe, disrupting operations',
      'A fake press badge has been used to access the family reunification area, where the impersonator is extracting personal details from victims',
      'A person in a high-visibility vest claiming to be from the utility company has been given access to the basement — no work order exists',
      'An individual with a forged police ID is issuing orders at the outer cordon, redirecting resources',
      'A tow truck with false municipal markings is removing vehicles from the scene — potentially removing evidence',
      'A man in a hazmat suit has entered the decontamination area claiming to be CBRN support — no agency has dispatched him',
      'A woman claiming to be a crisis counselor is collecting personal data from distressed survivors at the evacuation center',
      'A vehicle with cloned diplomatic plates has breached the inner cordon',
      'An impersonator claiming to be a fire marshal has shut down the backup generator, citing "safety violations"',
      "A person pretending to be a deceased victim's relative is attempting to claim their personal belongings from the evidence area",
      'A social worker impersonator is attempting to take custody of unaccompanied children at the evacuation center',
      'Someone in a delivery uniform has dropped off a suspicious package at the command post, claiming it is "supplies"',
    ],
  },
  {
    id: 'insider_leak',
    group: 'Trust & Insider',
    label: 'Insider intelligence leak',
    description: 'Operational details reaching media or adversary',
    examples: [
      'Operational radio frequencies are being monitored by a media organization — sensitive tactical movements are being broadcast live',
      'The response plan details appeared on social media 10 minutes before execution, suggesting someone in the command team is leaking',
      'A journalist quotes verbatim from a classified briefing that only 6 people attended — there is a mole',
      'The adversary appears to have advance knowledge of cordon movements, suggesting an insider communication channel',
      "A responder's personal phone was found recording video of the command board and transmitting it to an unknown number",
      'Internal casualty figures not yet released to the public are being quoted by a foreign news outlet',
      "The suspect's legal team files a motion that references details only available from the command post whiteboard",
      "A tactical team's approach route was posted on a messaging app 5 minutes before execution — the entry was compromised",
      'Photographs of the sensitive evidence board are circulating on a private Telegram group used by journalists',
      'The secure radio channel allocated to close protection has been compromised — principals are now exposed',
      'A whistleblower website publishes the incident command structure chart, including personal names and phone numbers',
      'The adversary detonates a secondary device at the exact location where a command briefing said the EOD team would assemble',
      'Internal communications show that someone forwarded the evacuation route map to an external email address',
      'A recently terminated employee still has active credentials and has been accessing the operations system remotely',
      'A document marked "SECRET" is photographed on a café table near the command post and shared online',
    ],
  },
  {
    id: 'sabotage',
    group: 'Trust & Insider',
    label: 'Equipment sabotage',
    description: 'Tampered chemicals, wrong coordinates, systems disabled',
    examples: [
      'Decontamination chemicals have been tampered with — patients processed through decon may not actually be clean',
      'Deliberately wrong GPS coordinates were relayed to the incoming relief convoy, sending them to an empty lot',
      "The building's fire suppression system was manually disabled from inside before the incident — this was not accidental",
      'Someone has physically cut the fiber optic cable feeding the CCTV network in the command post area',
      'Fuel in the generator feeding the triage area has been contaminated with water — power loss is imminent',
      'Tyre puncture strips have been placed on the main ambulance approach route — three vehicles are now disabled',
      'Road signs directing to the evacuation center have been deliberately turned to point the wrong way',
      'The fire alarm in the command post has been manually triggered, forcing an unnecessary evacuation during a critical phase',
      'Medical supplies at the staging area have been opened and mixed with incorrect labels',
      'Bollards controlling vehicle access to the pedestrian area have been welded shut in the down position',
      'A lock has been superglued on the emergency equipment cache, making it inaccessible without forced entry',
      'The backup power transfer switch at the hospital has been jammed in the off position',
      'Water in the portable tank for the decon shower has been contaminated with a skin irritant',
      "Critical gate keys to the venue's service entrances have gone missing from the key box — all locks must be cut",
      "Someone has reversed the polarity labels on the building's electrical switchboard, creating electrocution risk for responders",
    ],
  },
  {
    id: 'friendly_fire',
    group: 'Trust & Insider',
    label: 'Friendly fire / blue-on-blue',
    description: 'Mistaken identity incidents, wrong target engaged',
    examples: [
      'A plainclothes officer has been shot by a tactical team who mistook them for the suspect',
      'A private security contractor opened fire on arriving police officers during a moment of confusion',
      'The tactical team breached the wrong room, flash-banging a group of trapped civilians instead of the target',
      "An undercover operative's cover was not communicated to the cordon team — they were tackled and injured during apprehension",
      'Friendly drones from two different agencies collided over the incident zone, debris falling near the triage area',
      "A police dog handler's animal has bitten an allied officer during a chaotic foot pursuit in the dark",
      'Non-lethal crowd dispersal munitions were deployed toward a group that included embedded undercover officers',
      'A fire crew directed a high-pressure hose at a tactical team, mistaking their black uniforms for a hostile group',
      'A sniper team nearly engaged a reporter holding a telephoto camera that was mistaken for a weapon at distance',
      'Two tactical teams from different agencies converged on the same building from different sides and nearly fired on each other',
      'A volunteer in a donated military surplus jacket was tackled by soldiers who mistook him for an escaped suspect',
      'A medic vehicle that failed to identify itself was rammed by a pursuit vehicle at a checkpoint',
      "A cordon officer tasered a running paramedic who didn't hear the order to stop due to ambient noise",
      'Smoke grenades deployed by one team obscured the line of sight for another team conducting a simultaneous operation',
      'A mutual aid team from a neighboring jurisdiction arrived in unmarked vehicles and was initially treated as hostile by the on-scene force',
    ],
  },
  {
    id: 'stampede_crush',
    group: 'Trust & Insider',
    label: 'Stampede or crush risk',
    description: 'Crowd surge, panic movement, counter-flow collisions',
    examples: [
      'A crowd surge at a bottleneck exit has crushed several people against barriers — new casualties are being created by the evacuation itself',
      'Counter-flow collision between evacuees moving out and incoming responders is creating a dangerous crush in a narrow corridor',
      'A locked fire exit has created a fatal compression point — people at the back are pushing while the front cannot move',
      'Evacuees are climbing fences to escape, injuring themselves and others in the process',
      'An escalator has failed under the weight of evacuees, creating a pileup and crush at the bottom',
      'A crowd fleeing one exit is colliding with people fleeing from a different direction at a junction, creating a deadly pinch point',
      'A temporary barrier set up for crowd control has collapsed, causing a domino effect as people fall on top of each other',
      'Panicked crowds are surging toward a narrow bridge, and the structure is swaying under the dynamic load',
      'A turnstile system at a venue entrance is trapping people who cannot pass through fast enough, creating a compression',
      'People are being pushed down a stairwell faster than the lower levels can clear, creating a catastrophic pile-up',
      'A false report of danger at Evacuation Point A has caused everyone to rush to Point B, which cannot handle the volume',
      'Children separated from parents are moving against the crowd flow, creating eddies and collision points',
      'A revolving door has jammed with people trying to push through simultaneously, trapping a child',
      'Wet ground from firefighting water has caused multiple slip-and-fall incidents in the stampede path, creating obstacles',
      'The PA system announcement triggered a simultaneous rush toward all exits, exceeding the design flow rate of every corridor',
      'A crowd crush has developed at a security checkpoint where bags are being screened before evacuation is permitted',
    ],
  },
  {
    id: 'evacuation_refusal',
    group: 'Trust & Insider',
    label: 'Evacuation refusal',
    description: 'Residents refusing to leave, barricading, ceremony completion',
    examples: [
      'Elderly residents in the adjacent apartment block are refusing to leave their homes despite imminent structural collapse risk',
      'Business owners are barricading inside their shops to protect inventory, blocking fire access to the building interior',
      'A religious congregation insists on completing their ceremony before evacuating, with 300 people in a building rated at risk',
      'A group of squatters in the basement of the affected building refuse to evacuate because they fear deportation',
      'Hospital patients in the adjacent ward are refusing transfer because they distrust the ambulance teams sent to move them',
      "A hoarder's apartment is so full that the occupant physically cannot reach the door, and they refuse to let responders break in",
      'A wheelchair user insists on waiting for an accessible vehicle, refusing to be carried down stairs by responders',
      'A nightclub owner refuses to close, arguing that their patrons are safer inside than in the street',
      'Residents of a care home are too confused by the evacuation to cooperate, and several keep returning to their rooms',
      'A farmer refuses to evacuate because their livestock cannot be moved and they will not abandon their animals',
      'A laboratory researcher refuses to leave until they have secured experiments containing biologically sensitive material',
      'A chef insists on staying to turn off industrial ovens, claiming an explosion risk if they are abandoned',
      'A group of homeless people sheltering in an underpass refuse to leave their belongings despite rising floodwater',
      "A school teacher barricades 30 children in a classroom, refusing to open the door because they do not trust the responders' identity",
      'A pregnant woman in early labor refuses to evacuate by ambulance, insisting she will only go with a specific midwife who is off duty',
      "A film crew refuses to stop shooting, claiming their production insurance requires them to complete the day's schedule",
    ],
  },
];

export const INJECT_PRESSURE_TYPE_IDS = INJECT_PRESSURE_TYPES.map((t) => t.id);

export const INJECT_PRESSURE_TYPES_META = INJECT_PRESSURE_TYPES.map(
  ({ id, group, label, description }) => ({
    id,
    group,
    label,
    description,
  }),
);

/**
 * Build a thematic emphasis block from selected inject profile IDs.
 * Replaces the generic "WHAT THESE INJECTS ARE" / category example blocks
 * in inject generation prompts with focused thematic content.
 */
function buildThematicEmphasisBlock(
  profileIds: string[],
  context: 'universal' | 'team' | 'chaos',
  teamName?: string,
): string {
  const selected = profileIds
    .map((id) => INJECT_PRESSURE_TYPES.find((t) => t.id === id))
    .filter(Boolean) as InjectPressureType[];

  if (selected.length === 0) return '';

  const contextFraming =
    context === 'universal'
      ? 'These are EXTERNAL WORLD events visible to ALL teams — things happening around the crisis that players must react to but cannot prevent.'
      : context === 'team'
        ? `These are external events specifically impacting the ${teamName || 'focused'} team — things happening TO this team from the outside world.`
        : `These are non-procedural, socially volatile CHAOS events targeting the ${teamName || 'focused'} team — the messy human reality that no procedure manual covers.`;

  let weightInstr: string;
  if (selected.length === 2) {
    weightInstr = `Approximately 50% of injects should come from the PRIMARY theme and 50% from the SECONDARY theme.`;
  } else if (selected.length === 3) {
    weightInstr = `Approximately 40% of injects should come from the first theme, 30% from the second, and 30% from the third.`;
  } else {
    weightInstr = `Distribute injects roughly equally across all ${selected.length} themes (~${Math.round(100 / selected.length)}% each).`;
  }

  const themeBlocks = selected
    .map((t, i) => {
      const rank =
        i === 0 && selected.length <= 3
          ? 'PRIMARY'
          : selected.length <= 3
            ? 'SECONDARY'
            : `THEME ${i + 1}`;
      return `${rank}: ${t.label.toUpperCase()} — ${t.description}`;
    })
    .join('\n');

  return `THEMATIC EMPHASIS — ${selected.map((t) => t.label).join(' + ')}
${contextFraming}

${weightInstr}

${themeBlocks}

Invent specific complications that fit these themes using the venue research, similar incidents, and local geography provided below. Do NOT default to generic crisis management props — every complication must be grounded in something specific to THIS venue and locale.

Where possible, the selected themes SHOULD intersect and create compound complications — e.g. a ${selected[0].label.toLowerCase()} event that triggers or worsens a ${selected[selected.length > 1 ? 1 : 0].label.toLowerCase()} situation. These compound events are the most valuable because they test multi-dimensional decision-making.

Each inject must reference the specific scenario title, venue, and narrative details. Be geographically and culturally specific to the venue location.`;
}

/**
 * Tiered research context block for inject generation prompts.
 * Tier 1: similar cases exist → use them as creative fuel.
 * Tier 2: no cases but area_summary exists → use venue research.
 * Tier 3: neither → instruct AI to reason from venue/scenario specifics.
 */
function buildResearchContextBlock(
  researchContext: WarroomResearchContext | undefined,
  venue: string,
): string {
  const parts: string[] = [];

  const hasCases = researchContext?.similar_cases && researchContext.similar_cases.length > 0;
  const hasArea = !!researchContext?.area_summary;
  const hasCrowd = !!researchContext?.crowd_dynamics;

  if (hasCases) {
    parts.push(
      `REAL-WORLD PRECEDENTS — study these incidents for inspiration on what complications, intelligence sources, and unexpected developments actually occurred. Adapt them creatively to THIS venue — do not simply copy the same props or assets:\n${similarCasesToPromptBlock(researchContext!.similar_cases!)}`,
    );
  }

  if (hasArea) {
    const areaTruncated = researchContext!.area_summary!.slice(0, 4000);
    if (hasCases) {
      parts.push(
        `VENUE & AREA RESEARCH (use to ground injects in local reality):\n${areaTruncated}`,
      );
    } else {
      parts.push(
        `NO SIMILAR INCIDENTS FOUND — use the area research below as your creative fuel. Consider: what infrastructure exists at this venue? What communities live nearby? What transport links, utilities, or cultural dynamics could create complications?\n\nAREA RESEARCH:\n${areaTruncated}`,
      );
    }
  }

  if (hasCrowd) {
    parts.push(
      `CROWD DYNAMICS RESEARCH:\n${crowdDynamicsToPromptBlock(researchContext!.crowd_dynamics!)}`,
    );
  }

  if (!hasCases && !hasArea) {
    parts.push(
      `Reason from the scenario type, venue name ("${venue}"), setting, and terrain. What would ACTUALLY happen at this specific location? Think about local resources, cultural context, and environmental factors unique to this place. Do not fall back on generic crisis management textbook scenarios.`,
    );
  }

  return parts.length > 0 ? '\n' + parts.join('\n\n') : '';
}

import type {
  OsmVicinity,
  OsmOpenSpace,
  OsmBuilding,
  OsmRouteGeometry,
} from './osmVicinityService.js';
import {
  standardsToPromptBlock,
  similarCasesToPromptBlock,
  crowdDynamicsToPromptBlock,
  researchTeamWorkflows,
  type SimilarCase,
} from './warroomResearchService.js';
import type { CounterDefinition } from '../counterDefinitions.js';
import {
  pointInPolygon,
  circleToPolygon,
  scalePolygonFromCentroid,
  polygonCentroid,
  haversineM as geoHaversineM,
} from './geoUtils.js';

export interface WarroomScenarioPayload {
  scenario: {
    title: string;
    description: string;
    briefing: string;
    objectives: string[];
    initial_state: Record<string, unknown>;
    role_specific_briefs: Record<string, string>;
    category: string;
    difficulty: string;
    duration_minutes: number;
  };
  teams: Array<{
    team_name: string;
    team_description: string;
    min_participants: number;
    max_participants: number;
    counter_definitions?: CounterDefinition[];
    is_investigative?: boolean;
  }>;
  objectives: Array<{
    objective_id: string;
    objective_name: string;
    description: string;
    weight: number;
    success_criteria?: Record<string, unknown>;
  }>;
  time_injects: Array<{
    trigger_time_minutes: number;
    type: string;
    title: string;
    content: string;
    severity: string;
    inject_scope: string;
    target_teams: string[];
    requires_response?: boolean;
    requires_coordination?: boolean;
    conditions_to_appear?: { threshold?: number; conditions?: string[] } | { all: string[] };
    conditions_to_cancel?: string[];
    eligible_after_minutes?: number;
    objective_penalty?: { objective_id: string; reason: string; points: number };
    state_effect?: Record<string, unknown>;
  }>;
  condition_driven_injects?: Array<{
    title: string;
    content: string;
    type: string;
    severity: string;
    inject_scope: string;
    target_teams: string[];
    requires_response?: boolean;
    conditions_to_appear: { threshold?: number; conditions?: string[] } | { all: string[] };
    conditions_to_cancel?: string[];
    eligible_after_minutes?: number;
    objective_penalty?: { objective_id: string; reason: string; points: number };
    state_effect?: Record<string, unknown>;
  }>;
  decision_injects?: Array<{
    trigger_condition: string;
    type: string;
    title: string;
    content: string;
    severity: string;
    inject_scope: string;
    target_teams: string[];
    requires_response?: boolean;
    requires_coordination?: boolean;
    conditions_to_appear?: { threshold?: number; conditions?: string[] } | { all: string[] };
    conditions_to_cancel?: string[];
    eligible_after_minutes?: number;
    objective_penalty?: { objective_id: string; reason: string; points: number };
    state_effect?: Record<string, unknown>;
  }>;
  locations?: Array<{
    location_type: string;
    pin_category?: string;
    description?: string;
    label: string;
    coordinates: { lat: number; lng: number };
    conditions?: Record<string, unknown>;
    display_order: number;
    visible_to_teams?: string[];
  }>;
  floor_plans?: Array<{
    floor_level: string;
    floor_label: string;
    plan_svg?: string;
    plan_image_url?: string;
    bounds?: Record<string, unknown>;
    features: Array<{
      id: string;
      type: string;
      label: string;
      geometry?: Record<string, unknown>;
      properties?: Record<string, unknown>;
    }>;
    environmental_factors: Array<Record<string, unknown>>;
  }>;
  hazards?: Array<{
    hazard_type: string;
    location_lat: number;
    location_lng: number;
    floor_level: string;
    properties: Record<string, unknown>;
    assessment_criteria: string[];
    image_url?: string;
    image_sequence?: Array<{ at_minutes: number; image_url: string; description: string }>;
    status: string;
    appears_at_minutes: number;
    resolution_requirements?: Record<string, unknown>;
    personnel_requirements?: Record<string, unknown>;
    equipment_requirements?: Array<Record<string, unknown>>;
    deterioration_timeline?: Record<string, unknown>;
    enriched_description?: string;
    fire_class?: string;
    debris_type?: string;
    zones?: Array<{
      zone_type: string;
      radius_m: number;
      ppe_required: string[];
      allowed_teams: string[];
      activities: string[];
    }>;
  }>;
  casualties?: Array<{
    casualty_type: 'patient' | 'crowd' | 'evacuee_group' | 'convergent_crowd';
    location_lat: number;
    location_lng: number;
    floor_level: string;
    headcount: number;
    conditions: Record<string, unknown>;
    status: string;
    appears_at_minutes: number;
    destination_lat?: number;
    destination_lng?: number;
    destination_label?: string;
    movement_speed_mpm?: number;
  }>;
  equipment?: Array<{
    equipment_type: string;
    label: string;
    icon?: string;
    properties: Record<string, unknown>;
    applicable_teams?: string[];
  }>;
  insider_knowledge?: {
    osm_vicinity?: OsmVicinity;
    sector_standards?: string;
    sector_standards_structured?: import('./warroomResearchService.js').StandardsFinding[];
    team_doctrines?: Record<string, import('./warroomResearchService.js').StandardsFinding[]>;
    layout_ground_truth?: Record<string, unknown>;
    site_areas?: Array<Record<string, unknown>>;
    custom_facts?: Array<{ topic: string; summary: string; detail?: string }>;
    baseline_escalation_factors?: Array<{
      id: string;
      name: string;
      description: string;
      severity: string;
    }>;
    team_intelligence_dossiers?: Record<
      string,
      Array<{
        question: string;
        category: string;
        answer: string;
      }>
    >;
    team_workflows?: Record<
      string,
      {
        endgame: string;
        steps: string[];
        personnel_ratios?: Record<string, string>;
        sop_checklist?: string[];
      }
    >;
  };
}

export interface WarroomResearchContext {
  area_summary?: string;
  /** @deprecated use standards_findings instead */
  standards_summary?: string;
  standards_findings?: import('./warroomResearchService.js').StandardsFinding[];
  /** Pre-built per-team doctrine mapping from researchStandardsPerTeam */
  team_doctrines?: Record<string, import('./warroomResearchService.js').StandardsFinding[]>;
  similar_cases?: SimilarCase[];
  crowd_dynamics?: import('./warroomResearchService.js').CrowdDynamicsResearch;
}

export interface WarroomUserTeam {
  team_name: string;
  team_description: string;
  min_participants: number;
  max_participants: number;
}

export interface Phase1Result {
  scenario: WarroomScenarioPayload['scenario'];
  teams: WarroomScenarioPayload['teams'];
  objectives: WarroomScenarioPayload['objectives'];
}

/**
 * Load counter definitions from the scenario type JSON template.
 * Returns null if the template doesn't exist or has no team_counter_definitions.
 */
function loadTemplateCounterDefs(scenarioType: string): Record<string, CounterDefinition[]> | null {
  try {
    const filePath = path.join(
      process.cwd(),
      'scenario_templates/scenario_types',
      `${scenarioType}.json`,
    );
    if (fs.existsSync(filePath)) {
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (
        content.team_counter_definitions &&
        typeof content.team_counter_definitions === 'object'
      ) {
        return content.team_counter_definitions as Record<string, CounterDefinition[]>;
      }
    }
  } catch {
    // Template loading is best-effort
  }
  return null;
}

export interface WarroomGenerateInput {
  scenario_type: string;
  setting: string;
  terrain: string;
  location: string | null;
  venue_name?: string;
  /** The user's original free-text prompt, preserved for AI narrative generation. */
  original_prompt?: string;
  /** Nearby landmarks the user mentioned (e.g. "Ateneo de Davao University"). */
  landmarks?: string[];
  osm_vicinity?: OsmVicinity;
  osmOpenSpaces?: OsmOpenSpace[];
  osmBuildings?: OsmBuilding[];
  osmRouteGeometries?: OsmRouteGeometry[];
  geocode?: { lat: number; lng: number; display_name: string };
  complexity_tier: 'minimal' | 'standard' | 'full' | 'rich';
  /** Game duration in minutes (20–240, default 60). Drives inject volume and timing. */
  duration_minutes?: number;
  typeSpec: Record<string, unknown>;
  settingSpec: Record<string, unknown>;
  terrainSpec: Record<string, unknown>;
  researchContext?: WarroomResearchContext;
  userTeams?: WarroomUserTeam[];
  /** Pre-computed Phase 1 result; if provided, warroomGenerateScenario skips Phase 1. */
  phase1Preview?: Phase1Result;
  /** Selected inject pressure profile IDs (2-4) that steer thematic emphasis of generated injects. */
  inject_profiles?: string[];
  /** Weapon/threat profile extracted from the prompt — drives proportional hazard/casualty generation. */
  threat_profile?: ThreatProfile;
}

// ---------------------------------------------------------------------------
// Threat-class hazard rules — maps weapon_class to allowed hazard types,
// hazard count range, and injury emphasis for proportional generation.
// ---------------------------------------------------------------------------
interface ThreatHazardRule {
  allowed_hazards: string[];
  min_hazards: number;
  max_hazards: number;
  injury_emphasis: string[];
  casualty_range: [number, number];
  crowd_description: string;
}

export const THREAT_HAZARD_RULES: Record<string, ThreatHazardRule> = {
  melee_bladed: {
    allowed_hazards: ['debris', 'blood_trail', 'broken_glass'],
    min_hazards: 0,
    max_hazards: 2,
    injury_emphasis: ['laceration', 'stab_wound', 'hemorrhage', 'severed_tendon', 'psychological'],
    casualty_range: [15, 25],
    crowd_description:
      'Localized panic near the attacker. People immediately nearby scatter; those >50m away may not realize what is happening for minutes.',
  },
  melee_blunt: {
    allowed_hazards: ['debris', 'broken_glass', 'broken_furniture'],
    min_hazards: 0,
    max_hazards: 2,
    injury_emphasis: ['fracture', 'concussion', 'contusion', 'internal_bleeding', 'psychological'],
    casualty_range: [10, 20],
    crowd_description:
      'Localized panic near the attacker. Bystanders may not immediately identify the weapon or threat.',
  },
  firearm_handgun: {
    allowed_hazards: ['broken_glass', 'debris'],
    min_hazards: 0,
    max_hazards: 3,
    injury_emphasis: [
      'gunshot_wound',
      'hemorrhage',
      'penetrating_wound',
      'fracture',
      'psychological',
    ],
    casualty_range: [15, 25],
    crowd_description:
      'Gunshots cause immediate wide panic. People flee in all directions. Stampede risk at chokepoints.',
  },
  firearm_rifle: {
    allowed_hazards: ['broken_glass', 'debris', 'structural_damage'],
    min_hazards: 1,
    max_hazards: 4,
    injury_emphasis: [
      'gunshot_wound',
      'hemorrhage',
      'penetrating_wound',
      'fracture',
      'psychological',
    ],
    casualty_range: [20, 40],
    crowd_description:
      'Loud, sustained gunfire causes mass panic across a wide area. People drop to the ground, stampede toward exits.',
  },
  firearm_shotgun: {
    allowed_hazards: ['broken_glass', 'debris'],
    min_hazards: 0,
    max_hazards: 3,
    injury_emphasis: [
      'gunshot_wound',
      'hemorrhage',
      'penetrating_wound',
      'shrapnel_wound',
      'psychological',
    ],
    casualty_range: [15, 25],
    crowd_description:
      'Loud blasts cause immediate panic. Close-range devastation but limited range means crowds further away may initially freeze.',
  },
  explosive: {
    allowed_hazards: [
      'fire',
      'structural_collapse',
      'debris',
      'gas_leak',
      'smoke',
      'electrical',
      'explosion',
      'flood',
    ],
    min_hazards: 6,
    max_hazards: 15,
    injury_emphasis: [
      'blast_injury',
      'burn',
      'shrapnel_wound',
      'crush_injury',
      'amputation',
      'tympanic_rupture',
      'smoke_inhalation',
      'psychological',
    ],
    casualty_range: [25, 50],
    crowd_description:
      'Massive explosion causes instant mass panic across the entire venue. Secondary explosions feared. Total evacuation.',
  },
  chemical: {
    allowed_hazards: ['chemical_spill', 'smoke', 'contaminated_zone'],
    min_hazards: 2,
    max_hazards: 6,
    injury_emphasis: [
      'chemical_burn',
      'respiratory_failure',
      'nerve_agent_exposure',
      'skin_contamination',
      'psychological',
    ],
    casualty_range: [20, 40],
    crowd_description:
      'Invisible threat causes delayed panic — people start coughing, collapsing. Once recognized, mass stampede away from the source.',
  },
  biological: {
    allowed_hazards: ['contaminated_zone', 'biohazard_area'],
    min_hazards: 1,
    max_hazards: 4,
    injury_emphasis: [
      'respiratory_failure',
      'skin_contamination',
      'organ_failure',
      'psychological',
    ],
    casualty_range: [15, 30],
    crowd_description:
      'Delayed recognition. Panic escalates as news spreads. Quarantine fears cause secondary panic.',
  },
  vehicle: {
    allowed_hazards: ['debris', 'structural_damage', 'vehicle_wreckage'],
    min_hazards: 1,
    max_hazards: 4,
    injury_emphasis: [
      'crush_injury',
      'fracture',
      'internal_bleeding',
      'laceration',
      'traumatic_brain_injury',
      'psychological',
    ],
    casualty_range: [20, 35],
    crowd_description:
      'Sudden impact causes immediate scatter. Screaming, people running from the path of the vehicle. Debris field.',
  },
  incendiary: {
    allowed_hazards: ['fire', 'smoke', 'gas_leak', 'structural_collapse'],
    min_hazards: 3,
    max_hazards: 8,
    injury_emphasis: ['burn', 'smoke_inhalation', 'carbon_monoxide_poisoning', 'psychological'],
    casualty_range: [15, 30],
    crowd_description:
      'Fire visible and spreading. Smoke reduces visibility. Evacuation driven by fire and smoke.',
  },
  radiological: {
    allowed_hazards: [
      'radiation_zone',
      'contaminated_water',
      'airborne_plume',
      'contaminated_debris',
      'fallout_area',
    ],
    min_hazards: 4,
    max_hazards: 10,
    injury_emphasis: [
      'acute_radiation_syndrome',
      'beta_burn',
      'radiation_dermatitis',
      'thyroid_exposure',
      'internal_contamination',
      'contaminated_wound',
      'psychological',
      'nausea_vomiting',
    ],
    casualty_range: [20, 60],
    crowd_description:
      'Massive panic extending 30+ km. Traffic gridlock on evacuation routes. Residents self-evacuating in all directions. Rumors of meltdown spreading faster than official information.',
  },
  none: {
    allowed_hazards: ['debris', 'structural_damage'],
    min_hazards: 0,
    max_hazards: 3,
    injury_emphasis: ['crush_injury', 'fracture', 'asphyxiation', 'trampling', 'psychological'],
    casualty_range: [15, 30],
    crowd_description: 'Crowd dynamics cause the danger — stampede, crush, crowd surge.',
  },
};

function getThreatHazardRules(weaponClass: string): ThreatHazardRule {
  return THREAT_HAZARD_RULES[weaponClass] || THREAT_HAZARD_RULES['explosive'];
}

let _cachedWeaponAssessment: {
  key: string;
  lethality: number;
  adversaryMultiplier: number;
  minCasualties: number;
  maxCasualties: number;
} | null = null;

/**
 * Ask AI to assess weapon lethality and realistic casualty range.
 * Uses research context (similar real-world incidents) to ground the estimate
 * in actual historical data rather than static multipliers.
 * Results are cached per-generation so repeated calls don't duplicate work.
 */
async function assessWeaponLethality(
  weaponType: string,
  weaponClass: string,
  adversaryCount: number,
  baseCasualtyRange: [number, number],
  openAiApiKey: string,
  researchCases?: SimilarCase[],
): Promise<{
  lethality: number;
  adversaryMultiplier: number;
  minCasualties: number;
  maxCasualties: number;
}> {
  const cacheKey = `${weaponType}|${weaponClass}|${adversaryCount}|${baseCasualtyRange.join(',')}`;
  if (_cachedWeaponAssessment?.key === cacheKey) return _cachedWeaponAssessment;

  const fallbackLethality = 1.0;
  const fallbackAdvMult = adversaryCount <= 1 ? 1.0 : Math.min(3.5, 1 + (adversaryCount - 1) * 0.8);
  const fallback = {
    key: cacheKey,
    lethality: fallbackLethality,
    adversaryMultiplier: fallbackAdvMult,
    minCasualties: Math.round(baseCasualtyRange[0] * fallbackLethality * fallbackAdvMult),
    maxCasualties: Math.round(baseCasualtyRange[1] * fallbackLethality * fallbackAdvMult),
  };

  const researchBlock = researchCases?.length
    ? `\n\nREAL-WORLD REFERENCE INCIDENTS — use these to calibrate your estimates:\n${researchCases
        .map((c) => {
          const parts = [`- ${c.name}: ${c.summary}`];
          if (c.casualties_killed != null) parts.push(`  Killed: ${c.casualties_killed}`);
          if (c.casualties_injured != null) parts.push(`  Injured: ${c.casualties_injured}`);
          if (c.num_attackers != null) parts.push(`  Attackers: ${c.num_attackers}`);
          if (c.weapon_description) parts.push(`  Weapon: ${c.weapon_description}`);
          if (c.weapon_forensics) parts.push(`  Forensics: ${c.weapon_forensics}`);
          if (c.damage_radius_m != null) parts.push(`  Damage radius: ${c.damage_radius_m}m`);
          if (c.injury_breakdown) parts.push(`  Injury breakdown: ${c.injury_breakdown}`);
          if (c.response_time_minutes != null)
            parts.push(`  Response time: ${c.response_time_minutes} min`);
          if (c.containment_time_minutes != null)
            parts.push(`  Containment: ${c.containment_time_minutes} min`);
          if (c.environment) parts.push(`  Environment: ${c.environment}`);
          return parts.join('\n');
        })
        .join('\n')}`
    : '';

  try {
    const result = await callOpenAi<{
      lethality_multiplier: number;
      adversary_multiplier: number;
      realistic_min_casualties: number;
      realistic_max_casualties: number;
    }>(
      `You are an expert in weapon lethality assessment for crisis simulation exercises.

Given a weapon description, weapon class, number of attackers, the base casualty range for this weapon class, and (when available) real-world reference incidents with comparable weapons and circumstances, determine:

1. **lethality_multiplier** (0.5-3.0): How lethal is this specific weapon compared to a baseline weapon of its class?
   Reason about the weapon's reach, cutting/striking power, rate of harm, and any real-world incident data provided.

2. **adversary_multiplier** (1.0-4.0): How much do multiple attackers multiply the casualty count?
   Consider whether attackers are coordinated, covering different areas, or acting independently.
   1 attacker = 1.0; multiple attackers with melee weapons cover more ground (~1.5-2.0 for 2); diminishing returns above 3.

3. **realistic_min_casualties** and **realistic_max_casualties**: The final realistic casualty range.
   Start with base_range * lethality_multiplier * adversary_multiplier.
   The base_range already accounts for the number of attackers and the exercise designer's intent — do NOT reduce it.
   Real-world reference incidents (if provided) should be used to INCREASE accuracy of injury patterns, NOT to lower the casualty count below the base range.
   Your realistic_min_casualties MUST be >= the lower bound of the base range. Your realistic_max_casualties MUST be >= the upper bound of the base range.
   This is a training exercise — higher casualty counts create better learning pressure.

Return ONLY valid JSON: { "lethality_multiplier": number, "adversary_multiplier": number, "realistic_min_casualties": number, "realistic_max_casualties": number }`,
      `Weapon: "${weaponType}" (class: ${weaponClass})
Attackers: ${adversaryCount}
Base casualty range for this weapon class: ${baseCasualtyRange[0]}-${baseCasualtyRange[1]}${researchBlock}`,
      openAiApiKey,
      200,
      0,
    );

    const assessed = {
      key: cacheKey,
      lethality: Math.max(0.5, Math.min(3.0, result.lethality_multiplier || fallbackLethality)),
      adversaryMultiplier: Math.max(
        1.0,
        Math.min(4.0, result.adversary_multiplier || fallbackAdvMult),
      ),
      minCasualties: Math.max(
        baseCasualtyRange[0],
        result.realistic_min_casualties || fallback.minCasualties,
      ),
      maxCasualties: Math.max(
        baseCasualtyRange[1],
        result.realistic_max_casualties || fallback.maxCasualties,
      ),
    };
    if (assessed.minCasualties > assessed.maxCasualties) {
      assessed.maxCasualties = assessed.minCasualties + 5;
    }
    _cachedWeaponAssessment = assessed;
    return assessed;
  } catch {
    _cachedWeaponAssessment = fallback;
    return fallback;
  }
}

async function buildThreatProfileBlock(
  threatProfile: ThreatProfile | undefined,
  openAiApiKey: string,
  researchCases?: SimilarCase[],
): Promise<string> {
  if (!threatProfile) return '';
  const rules = getThreatHazardRules(threatProfile.weapon_class);
  const advScale = Math.min(threatProfile.adversary_count, 4);
  const scaledRange: [number, number] = [
    Math.round(rules.casualty_range[0] * advScale),
    Math.round(rules.casualty_range[1] * advScale),
  ];
  const assessed = await assessWeaponLethality(
    threatProfile.weapon_type,
    threatProfile.weapon_class,
    threatProfile.adversary_count,
    scaledRange,
    openAiApiKey,
    researchCases,
  );
  return `
THREAT PROFILE (CRITICAL — read carefully and obey):
- Weapon: ${threatProfile.weapon_type} (class: ${threatProfile.weapon_class})
- Threat scale: ${threatProfile.threat_scale}
- Adversary count: ${threatProfile.adversary_count}
- AI-assessed weapon lethality: ${assessed.lethality.toFixed(1)}x (adversary multiplier: ${assessed.adversaryMultiplier.toFixed(1)}x)
- Can cause structural damage: ${threatProfile.expected_damage.structural ? 'YES' : 'NO — do NOT generate structural collapse, building damage, or infrastructure failure'}
- Can cause fire: ${threatProfile.expected_damage.fire ? 'YES' : 'NO — do NOT generate fire, smoke, or heat-related hazards'}
- Can cause blast: ${threatProfile.expected_damage.blast ? 'YES' : 'NO — do NOT generate explosion, blast wave, or shrapnel hazards'}
- Can cause chemical contamination: ${threatProfile.expected_damage.chemical ? 'YES' : 'NO — do NOT generate chemical, biological, or contamination hazards'}
- Crowd panic radius: ${threatProfile.expected_damage.crowd_panic_radius}
- Realistic injury types for this weapon: ${threatProfile.injury_types.join(', ')}
- Crowd behavior: ${rules.crowd_description}

ALLOWED hazard types for this weapon class: ${rules.allowed_hazards.join(', ')}
Generate ${rules.min_hazards}-${rules.max_hazards} hazards MAXIMUM. Do NOT exceed this range.
Generate ${assessed.minCasualties}-${assessed.maxCasualties} casualties (scaled for ${threatProfile.adversary_count} attacker(s) with ${threatProfile.weapon_type}).
FORBIDDEN: Do NOT generate any hazard type not in the allowed list above. A ${threatProfile.weapon_type} CANNOT cause ${threatProfile.expected_damage.structural ? '' : 'structural collapse, '}${threatProfile.expected_damage.fire ? '' : 'fire, '}${threatProfile.expected_damage.blast ? '' : 'explosions, '}${threatProfile.expected_damage.chemical ? '' : 'chemical contamination, '}or environmental hazards beyond what this weapon physically produces.
`;
}

export type WarroomAiProgressCallback = (message: string) => void;

const VALID_INJECT_TYPES = [
  'media_report',
  'field_update',
  'citizen_call',
  'intel_brief',
  'resource_shortage',
  'weather_change',
  'political_pressure',
];

function normalizeInjectType(type: string): string {
  const t = type?.toLowerCase().replace(/\s+/g, '_') || 'field_update';
  return VALID_INJECT_TYPES.includes(t) ? t : 'field_update';
}

/**
 * Classify teams as operational (move pins, handle patients, chase adversaries)
 * or non_operational (media, communications — no map interaction).
 * Non-operational teams receive more pre-scripted injects since they don't get
 * reactive pressure from gameplay mechanics.
 */
async function classifyTeamTypes(
  teams: Array<{ team_name: string; team_description?: string }>,
  scenarioType: string,
  openAiApiKey: string,
): Promise<Record<string, 'operational' | 'non_operational'>> {
  const fallback: Record<string, 'operational' | 'non_operational'> = {};
  for (const t of teams) fallback[t.team_name] = 'operational';
  if (teams.length === 0) return fallback;

  const teamList = teams
    .map((t) => `- ${t.team_name}${t.team_description ? `: ${t.team_description}` : ''}`)
    .join('\n');
  try {
    const result = await callOpenAi<Record<string, string>>(
      `You classify crisis exercise teams into two categories:
- "operational": teams that physically interact with the incident — moving patients, managing map pins, setting up cordons, chasing suspects, running triage, performing evacuation, firefighting, HAZMAT operations, security patrols.
- "non_operational": teams that handle information, communications, media relations, public affairs, press briefings, stakeholder liaison — they do NOT move pins or patients on the map.

Return ONLY valid JSON: { "team_name": "operational" | "non_operational" } for each team.`,
      `Scenario type: ${scenarioType}\nTeams:\n${teamList}`,
      openAiApiKey,
      200,
      0,
    );
    for (const t of teams) {
      const val = result[t.team_name];
      if (val === 'operational' || val === 'non_operational') {
        fallback[t.team_name] = val;
      }
    }
  } catch {
    // fallback: treat all teams as operational
  }
  return fallback;
}

function repairTruncatedJson(raw: string): string {
  let s = raw.trim();
  // Strip trailing commas before we close brackets
  s = s.replace(/,\s*$/, '');

  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (const ch of s) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    if (ch === '}' || ch === ']') stack.pop();
  }
  if (inString) s += '"';
  // Close any remaining open brackets/braces in reverse order
  while (stack.length > 0) {
    const opener = stack.pop();
    // Strip trailing commas before closing
    s = s.replace(/,\s*$/, '');
    s += opener === '{' ? '}' : ']';
  }
  return s;
}

async function callOpenAi<T>(
  systemPrompt: string,
  userPrompt: string,
  openAiApiKey: string,
  maxTokens = 4000,
  temperature = 0.7,
  _retryCount = 0,
): Promise<T> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openAiApiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg =
      (err as { error?: { message?: string } }).error?.message ||
      `OpenAI API error: ${response.status}`;
    logger.error({ status: response.status, msg }, 'Warroom AI call failed');
    throw new Error(msg);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('No content from OpenAI');
  }

  const finishReason = data.choices?.[0]?.finish_reason as string | undefined;
  const wasTruncated = finishReason === 'length';

  // Try normal parse first
  try {
    return JSON.parse(content) as T;
  } catch {
    // Always attempt JSON repair (handles both truncation and minor malformation)
    logger.warn(
      { finishReason, wasTruncated, contentLength: content.length, maxTokens },
      'JSON parse failed; attempting repair',
    );
    try {
      const repaired = repairTruncatedJson(content);
      return JSON.parse(repaired) as T;
    } catch {
      // Repair failed — retry with higher budget if we haven't already
      if (_retryCount < 1) {
        const newBudget = Math.round(maxTokens * 1.6);
        logger.info(
          { oldBudget: maxTokens, newBudget, retryCount: _retryCount + 1 },
          'Retrying callOpenAi with higher token budget after JSON repair failure',
        );
        return callOpenAi<T>(
          systemPrompt,
          userPrompt,
          openAiApiKey,
          newBudget,
          temperature,
          _retryCount + 1,
        );
      }
    }
    throw new Error(
      `JSON parse failed (finish_reason=${finishReason}, length=${content.length}, maxTokens=${maxTokens})`,
    );
  }
}

function getRequiredTeamsFromTemplate(
  typeSpec: Record<string, unknown>,
): WarroomScenarioPayload['teams'] {
  const teams = typeSpec.required_teams as
    | Array<{
        team_name: string;
        team_description: string;
        min_participants?: number;
        max_participants?: number;
        is_investigative?: boolean;
      }>
    | undefined;
  if (!Array.isArray(teams) || teams.length === 0) return [];
  return teams.map((t) => ({
    team_name: t.team_name,
    team_description: t.team_description || '',
    min_participants: t.min_participants ?? 1,
    max_participants: t.max_participants ?? 10,
    ...(t.is_investigative ? { is_investigative: true } : {}),
  }));
}

/**
 * Phase 1: Generate teams and core scenario (title, description, briefing, objectives).
 * When userTeams provided, only generates core scenario; uses userTeams as teams.
 */
async function generateTeamsAndCore(
  input: WarroomGenerateInput,
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
): Promise<{
  scenario: WarroomScenarioPayload['scenario'];
  teams: WarroomScenarioPayload['teams'];
  objectives: WarroomScenarioPayload['objectives'];
}> {
  const hasUserTeams = input.userTeams && input.userTeams.length > 0;
  onProgress?.(
    hasUserTeams ? 'Generating core scenario...' : 'Generating teams and core scenario...',
  );

  const {
    scenario_type,
    setting,
    terrain,
    location,
    venue_name,
    original_prompt,
    landmarks,
    typeSpec,
    settingSpec,
    terrainSpec,
    researchContext,
    userTeams,
  } = input;
  const venue = venue_name || location || setting;
  const standardsBlock =
    researchContext?.standards_findings && researchContext.standards_findings.length > 0
      ? `\n\nRESPONSE STANDARDS (use these to make injects and objectives realistic):\n${standardsToPromptBlock(researchContext.standards_findings)}`
      : researchContext?.standards_summary
        ? `\nStandards: ${researchContext.standards_summary}`
        : '';
  const similarCasesBlock =
    researchContext?.similar_cases && researchContext.similar_cases.length > 0
      ? `\n\nSIMILAR REAL INCIDENTS (how events like this have unfolded — use for realistic dynamics):\n${similarCasesToPromptBlock(researchContext.similar_cases)}`
      : '';
  const researchBlock =
    researchContext?.area_summary || standardsBlock || similarCasesBlock
      ? `\nResearch context:\n${researchContext?.area_summary || ''}${standardsBlock}${similarCasesBlock}`
      : '';

  const teamsBlock = hasUserTeams
    ? ''
    : `,
  "teams": [
    { "team_name": "string", "team_description": "string", "min_participants": 2, "max_participants": 8, "is_investigative": false },
    ...
  ]`;
  const teamsRule = hasUserTeams
    ? ''
    : '\n- You MUST include at least 4 teams. Use required_teams from the scenario type template as a base; you may add or adapt.' +
      '\n- Set "is_investigative": true on any team whose primary role involves investigating, pursuing, or tracking adversaries (e.g. police, intelligence, detective). Most scenarios have 1 investigative team; some have 0.';

  const originalPromptBlock = original_prompt
    ? `\nUser's original request: "${original_prompt}"\nIMPORTANT: The scenario title, description, and briefing MUST reference the specific venue/location the user described. Do NOT substitute a different venue type or name.`
    : '';
  const landmarksBlock =
    landmarks && landmarks.length > 0
      ? `\nNearby landmarks mentioned by user: ${landmarks.join(', ')}\nIncorporate these landmarks into the scenario narrative where appropriate.`
      : '';

  const systemPrompt = `You are an expert crisis management scenario designer.

Scenario type: ${scenario_type}
Setting: ${setting}
Terrain: ${terrain}
Venue: ${venue}${originalPromptBlock}${landmarksBlock}
${researchBlock}

Template context:
- Scenario type: ${JSON.stringify(typeSpec)}
- Setting: ${JSON.stringify(settingSpec)}
- Terrain: ${JSON.stringify(terrainSpec)}

Return ONLY valid JSON in this exact structure (no markdown, no explanation):
{
  "scenario": {
    "title": "string - concise scenario title",
    "description": "string - 2-4 sentence overview of the crisis",
    "briefing": "string - 2-3 paragraph operational briefing for participants",
    "objectives": ["string - objective 1", "string - objective 2", "..."],
    "initial_state": {},
    "role_specific_briefs": {},
    "category": "terrorism",
    "difficulty": "advanced",
    "duration_minutes": ${input.duration_minutes ?? 60}
  }${teamsBlock},
  "objectives": [
    { "objective_id": "id", "objective_name": "name", "description": "string", "weight": 25 },
    ...
  ]
}

RULES:${teamsRule}
- description and briefing MUST be non-empty (2+ sentences each).
- objectives array in scenario: 3-5 high-level objectives as strings.
- objectives array at root: 3-5 detailed objective objects with objective_id, objective_name, description, weight.`;

  const userPrompt = hasUserTeams
    ? `Create the core scenario for a ${input.complexity_tier} complexity ${scenario_type} at ${venue}.`
    : `Create the core scenario and teams for a ${input.complexity_tier} complexity ${scenario_type} at ${venue}.`;

  const parsed = await callOpenAi<{
    scenario?: {
      title?: string;
      description?: string;
      briefing?: string;
      objectives?: string[];
      initial_state?: Record<string, unknown>;
      role_specific_briefs?: Record<string, string>;
      category?: string;
      difficulty?: string;
      duration_minutes?: number;
    };
    teams?: WarroomScenarioPayload['teams'];
    objectives?: WarroomScenarioPayload['objectives'];
  }>(systemPrompt, userPrompt, openAiApiKey, 3000);

  const templateTeams = getRequiredTeamsFromTemplate(typeSpec);
  const teams = hasUserTeams
    ? userTeams!
    : parsed.teams && parsed.teams.length >= 4
      ? parsed.teams
      : templateTeams.length > 0
        ? templateTeams
        : parsed.teams || [];

  const scenarioObjectives =
    Array.isArray(parsed.scenario?.objectives) && parsed.scenario.objectives.length > 0
      ? parsed.scenario.objectives
      : parsed.objectives?.map((o) => o.objective_name) || [];

  const description =
    parsed.scenario?.description?.trim() ||
    parsed.scenario?.briefing?.slice(0, 500) ||
    `${scenario_type} at ${venue}`;
  const briefing = parsed.scenario?.briefing?.trim() || description;

  const objectives =
    parsed.objectives && parsed.objectives.length > 0
      ? parsed.objectives
      : scenarioObjectives.length > 0
        ? scenarioObjectives.map((name, i) => ({
            objective_id: `obj_${i}`,
            objective_name: name,
            description: name,
            weight: 25,
            success_criteria: {},
          }))
        : [
            {
              objective_id: 'obj_0',
              objective_name: 'Coordinate response',
              description: 'Establish effective multi-agency coordination',
              weight: 25,
              success_criteria: {},
            },
            {
              objective_id: 'obj_1',
              objective_name: 'Minimize harm',
              description: 'Protect lives and reduce casualties',
              weight: 25,
              success_criteria: {},
            },
          ];

  const finalScenarioObjectives =
    scenarioObjectives.length > 0 ? scenarioObjectives : objectives.map((o) => o.objective_name);

  return {
    scenario: {
      title: parsed.scenario?.title || `${scenario_type} at ${venue}`,
      description,
      briefing,
      objectives: finalScenarioObjectives,
      initial_state: parsed.scenario?.initial_state || {},
      role_specific_briefs: parsed.scenario?.role_specific_briefs || {},
      category: parsed.scenario?.category || 'terrorism',
      difficulty: parsed.scenario?.difficulty || 'advanced',
      duration_minutes: input.duration_minutes ?? parsed.scenario?.duration_minutes ?? 60,
    },
    teams,
    objectives,
  };
}

// ---------------------------------------------------------------------------
// Inject timing helpers
// ---------------------------------------------------------------------------

function getPhaseLabelShort(minute: number): string {
  if (minute <= 15) return 'setup';
  if (minute <= 35) return 'escalation';
  if (minute <= 50) return 'peak';
  return 'resolution';
}

/**
 * Pre-assign time slots to universal injects and each team before any AI call fires.
 * Operational teams get 2-4 time slots; non-operational teams (media etc.) get 7.
 * Universal gets 3-5 slots (excluding T+0 which is deterministic).
 */
function buildTimingManifest(
  teamNames: string[],
  durationMinutes = 60,
  teamTypes?: Record<string, 'operational' | 'non_operational'>,
): {
  universalSlots: number[];
  teamSlots: Record<string, number[]>;
  chaosSlots: Record<string, number[]>;
  teamChaosCount: Record<string, number>;
} {
  // Universal: 3-5 slots spread across the timeline (excluding T+0)
  const universalCount = 3 + Math.min(2, Math.floor(durationMinutes / 30));
  const universalSlots: number[] = [];
  for (let i = 0; i < universalCount; i++) {
    const t = Math.round(((i + 1) / (universalCount + 1)) * durationMinutes);
    universalSlots.push(Math.max(5, Math.min(durationMinutes - 5, t)));
  }

  const JITTER = [0, 2, -1, 3, 1, -2, 2, -1, 1, 0];
  const teamSlots: Record<string, number[]> = {};
  const chaosSlots: Record<string, number[]> = {};
  const teamChaosCount: Record<string, number> = {};

  for (let i = 0; i < teamNames.length; i++) {
    const name = teamNames[i];
    const isNonOp = teamTypes?.[name] === 'non_operational';
    const timeCount = isNonOp ? 7 : Math.min(4, Math.max(2, Math.floor(durationMinutes / 20)));
    const chaosCount = isNonOp ? 5 : Math.min(3, Math.max(2, Math.floor(durationMinutes / 25)));

    const jitter = JITTER[i % JITTER.length];
    const slots: number[] = [];
    for (let j = 0; j < timeCount; j++) {
      const base = Math.round(((j + 1) / (timeCount + 1)) * durationMinutes);
      const raw = base + jitter;
      slots.push(Math.max(3, Math.min(durationMinutes - 2, raw)));
    }
    teamSlots[name] = slots;

    const cSlots: number[] = [];
    for (let j = 0; j < chaosCount; j++) {
      const base = Math.round(((j + 1) / (chaosCount + 1)) * durationMinutes);
      cSlots.push(Math.max(3, Math.min(durationMinutes - 2, base)));
    }
    chaosSlots[name] = cSlots;
    teamChaosCount[name] = chaosCount;
  }

  return { universalSlots, teamSlots, chaosSlots, teamChaosCount };
}

/**
 * Post-processing safety net: ensures no 5-minute window in [0, durationMinutes) is
 * completely empty of injects. If a gap is found, the nearest inject is shifted up to
 * ±3 minutes to close it. Returns a new sorted array (originals are not mutated).
 */
function normalizeInjectTiming(
  injects: WarroomScenarioPayload['time_injects'],
  durationMinutes = 60,
): WarroomScenarioPayload['time_injects'] {
  if (injects.length === 0) return injects;

  const result = injects.map((inj) => ({ ...inj }));
  result.sort((a, b) => a.trigger_time_minutes - b.trigger_time_minutes);

  const GAP = 5;
  const MAX_SHIFT = 3;
  const numWindows = Math.ceil(durationMinutes / GAP);

  for (let w = 0; w < numWindows; w++) {
    const wStart = w * GAP;
    const wEnd = wStart + GAP;
    const covered = result.some(
      (inj) => inj.trigger_time_minutes >= wStart && inj.trigger_time_minutes < wEnd,
    );
    if (!covered) {
      const midpoint = wStart + GAP / 2;
      let best: (typeof result)[0] | null = null;
      let bestDist = Infinity;
      for (const inj of result) {
        const dist = Math.abs(inj.trigger_time_minutes - midpoint);
        if (dist < bestDist) {
          best = inj;
          bestDist = dist;
        }
      }
      if (best !== null && bestDist <= GAP + MAX_SHIFT) {
        best.trigger_time_minutes = Math.round(
          Math.max(0, Math.min(durationMinutes - 1, midpoint)),
        );
      }
    }
  }

  return result.sort((a, b) => a.trigger_time_minutes - b.trigger_time_minutes);
}

const DEDUP_SYSTEM_PROMPT = `You are a deduplication judge for crisis exercise injects.

Given a CANDIDATE inject and a list of EXISTING injects, determine if the candidate is thematically similar to ANY existing inject TARGETING THE SAME AUDIENCE.

Rules:
- Two injects are "similar" if they share the same underlying theme, character archetype, social dynamic, or crisis trope — even if the wording differs.
- Examples of similar pairs: "parents demand access" & "family confrontation at cordon", "fake credentials" & "impersonator tries to enter", "secondary device found" & "bomb threat at nearby location".
- Universal injects (scope=universal) are seen by ALL teams, so a universal inject and a team-specific inject with the same theme ARE duplicates.
- Two team-specific injects targeting DIFFERENT teams are NOT duplicates — different teams can face similar themes independently.

Return JSON: { "duplicate": true } if the candidate duplicates an existing inject for the same audience, or { "duplicate": false } if it is unique.`;

function formatInjectForDedup(inj: {
  title: string;
  content?: string;
  inject_scope?: string;
  target_teams?: string[];
}): string {
  const scope =
    inj.inject_scope === 'universal'
      ? '[universal]'
      : `[→ ${(inj.target_teams || []).join(', ') || 'unknown'}]`;
  return `${scope} ${inj.title}: ${(inj.content || '').slice(0, 120)}`;
}

/**
 * Dedup a single stream of injects against a shared context (universals).
 * Walks sequentially within the stream; each candidate checks against
 * the universal context + previously accepted injects in this stream.
 */
async function dedupStream<
  T extends { title: string; content?: string; inject_scope?: string; target_teams?: string[] },
>(injects: T[], universalContext: string, openAiApiKey: string): Promise<T[]> {
  if (injects.length === 0) return injects;

  const kept: T[] = [];
  for (const candidate of injects) {
    const existing = [
      universalContext,
      ...kept.map((k, idx) => `[${idx}] ${formatInjectForDedup(k)}`),
    ]
      .filter(Boolean)
      .join('\n');
    try {
      const result = await callOpenAi<{ duplicate: boolean }>(
        DEDUP_SYSTEM_PROMPT,
        `EXISTING INJECTS:\n${existing}\n\nCANDIDATE:\n${formatInjectForDedup(candidate)}`,
        openAiApiKey,
        50,
        0,
      );
      if (!result.duplicate) kept.push(candidate);
    } catch {
      kept.push(candidate);
    }
  }
  return kept;
}

/**
 * Parallel per-team deduplication for time injects.
 * 1. Dedup universals among themselves (small sequential pass).
 * 2. Group team-specific injects by target team.
 * 3. Run each team's dedup in parallel — each stream only sees universals + its own team.
 * 4. Merge results: T+0 + universals + all team streams.
 */
async function deduplicateInjectsByTheme(
  injects: WarroomScenarioPayload['time_injects'],
  openAiApiKey: string,
): Promise<WarroomScenarioPayload['time_injects']> {
  if (injects.length <= 2) return injects;

  // Separate T+0, universals, and per-team injects
  const t0 = injects.filter((i) => (i.trigger_time_minutes ?? 0) === 0);
  const universals = injects.filter(
    (i) => (i.trigger_time_minutes ?? 0) > 0 && i.inject_scope === 'universal',
  );
  const teamInjects = injects.filter(
    (i) => (i.trigger_time_minutes ?? 0) > 0 && i.inject_scope !== 'universal',
  );

  // Dedup universals among themselves (+ T+0 as context)
  const t0Context = t0.map((k) => formatInjectForDedup(k)).join('\n');
  const dedupedUniversals = await dedupStream(universals, t0Context, openAiApiKey);

  // Build universal context string for team streams
  const universalContext = [
    ...t0.map((k) => formatInjectForDedup(k)),
    ...dedupedUniversals.map((k) => formatInjectForDedup(k)),
  ].join('\n');

  // Group team injects by target team
  const byTeam = new Map<string, WarroomScenarioPayload['time_injects']>();
  for (const inj of teamInjects) {
    const team = (inj.target_teams || [])[0] || '__unknown__';
    const arr = byTeam.get(team) || [];
    arr.push(inj);
    byTeam.set(team, arr);
  }

  // Dedup each team's injects in parallel — each only sees universals + own team
  const teamResults = await Promise.all(
    Array.from(byTeam.entries()).map(([, teamInjs]) =>
      dedupStream(teamInjs, universalContext, openAiApiKey),
    ),
  );

  return [...t0, ...dedupedUniversals, ...teamResults.flat()];
}

/**
 * Parallel per-team dedup for condition-driven (chaos) injects.
 * Each team's condition injects are deduped against:
 * - Universal time injects (shared context)
 * - That team's own accepted time injects
 * - Previously accepted condition injects for that team
 * All team streams run in parallel.
 */
async function deduplicateConditionInjectsByTheme(
  injects: NonNullable<WarroomScenarioPayload['condition_driven_injects']>,
  acceptedTimeInjects: WarroomScenarioPayload['time_injects'],
  openAiApiKey: string,
): Promise<NonNullable<WarroomScenarioPayload['condition_driven_injects']>> {
  if (injects.length === 0) return injects;

  // Build per-team context from accepted time injects
  const universalTimeContext = acceptedTimeInjects
    .filter((i) => i.inject_scope === 'universal')
    .map((i, idx) => `[time-univ-${idx}] ${formatInjectForDedup(i)}`)
    .join('\n');

  const teamTimeMap = new Map<string, string[]>();
  for (const inj of acceptedTimeInjects) {
    if (inj.inject_scope === 'universal') continue;
    const team = (inj.target_teams || [])[0] || '__unknown__';
    const arr = teamTimeMap.get(team) || [];
    arr.push(`[time-${arr.length}] ${formatInjectForDedup(inj)}`);
    teamTimeMap.set(team, arr);
  }

  // Group condition injects by target team
  const byTeam = new Map<string, NonNullable<WarroomScenarioPayload['condition_driven_injects']>>();
  for (const inj of injects) {
    const team = (inj.target_teams || [])[0] || '__unknown__';
    const arr = byTeam.get(team) || [];
    arr.push(inj);
    byTeam.set(team, arr);
  }

  // Dedup each team's conditions in parallel
  const teamResults = await Promise.all(
    Array.from(byTeam.entries()).map(([team, condInjs]) => {
      const teamContext = [universalTimeContext, ...(teamTimeMap.get(team) || [])]
        .filter(Boolean)
        .join('\n');
      return dedupStream(condInjs, teamContext, openAiApiKey);
    }),
  );

  return teamResults.flat();
}

// ---------------------------------------------------------------------------
// Team state schema hint — used by Phase 4b and 4d prompts
// ---------------------------------------------------------------------------

/**
 * Build a canonical initial state shape for each team based on team-name pattern matching.
 * This is passed into the AI prompt so it knows exactly which state keys to populate per variant.
 * The AI fills in the VALUES and may extend with extra scenario-specific keys.
 */
export function buildTeamStateSchemaHint(
  teamNames: string[],
): Record<string, Record<string, unknown>> {
  const schema: Record<string, Record<string, unknown>> = {};
  for (const name of teamNames) {
    const n = name.toLowerCase();
    if (/evacuation|evac/.test(n)) {
      schema['evacuation_state'] = {
        exits_congested: [],
        flow_control_decided: false,
        coordination_with_triage: false,
        evacuated_count: 0,
        total_evacuees: 1000,
      };
    } else if (/triage|medical/.test(n)) {
      schema['triage_state'] = {
        supply_level: 'adequate',
        surge_active: false,
        prioritisation_decided: false,
        supply_request_made: false,
        deaths_on_site: 0,
        critical_pending: 0,
        handed_over_to_hospital: 0,
        patients_being_treated: 0,
        patients_waiting: 0,
        casualties: 0,
      };
    } else if (/media|comm/.test(n)) {
      schema['media_state'] = {
        first_statement_issued: false,
        misinformation_addressed: false,
        journalist_arrived: false,
        statements_issued: 0,
        misinformation_addressed_count: 0,
      };
    } else if (/police|law/.test(n)) {
      schema['police_state'] = {
        perimeter_established: false,
        tactical_team_ready: false,
        armed_units: 0,
        inner_cordon_radius_m: 200,
      };
    } else if (/negotiat/.test(n)) {
      schema['negotiation_state'] = {
        contact_established: false,
        demands_received: false,
        active_session: false,
        sessions_count: 0,
        last_contact_minutes_ago: null,
      };
    } else if (/intel/.test(n)) {
      schema['intelligence_state'] = {
        hostage_count_confirmed: null,
        threat_level: 'high',
        perpetrator_count_known: false,
        inside_intel: false,
      };
    } else if (/fire/.test(n)) {
      schema['fire_state'] = {
        fire_contained: false,
        entry_safe: false,
        units_deployed: 0,
        hotspots: [],
      };
    } else {
      const key = `${n.replace(/\s+/g, '_')}_state`;
      schema[key] = {
        operational_status: 'standby',
        ready: false,
        resources_deployed: 0,
      };
    }
  }
  return schema;
}

// ---------------------------------------------------------------------------
// Phase: Counter Definitions per team (scenario-specific metrics)
// ---------------------------------------------------------------------------

const COUNTER_BEHAVIOR_CATALOG = `BEHAVIOR TYPES (you MUST pick from this list — do NOT invent new ones):

1. "time_rate" — a numeric counter that advances automatically each game tick.
   Config: base_rate_per_min (number), cap_key (key of another counter that is the ceiling),
   requires_flag (key of a boolean counter that must be true before ticking starts),
   robustness_affects (bool — team robustness score modifies rate),
   robustness_low_mult (multiplier when robustness<=4, default 0.25),
   robustness_high_mult (multiplier when robustness>=8, default 1.25),
   congestion_halves (bool — halved when unmanaged congested exits exist),
   impact_sensitive (bool — cross-team impact score modifies rate).

2. "decision_toggle" — a boolean counter flipped to true when a matching player decision is detected.
   Config: keywords (string[]), categories (string[]).

3. "decision_increment" — a numeric counter incremented by 1 each time a matching decision is made.
   Config: keywords (string[]), categories (string[]).

4. "derived" — a numeric counter recomputed each tick from other counters (e.g. patients_waiting = pool - processed).
   Config: source_pool_key (key whose value is the pool), pool_fraction (fraction of pool, e.g. 0.25),
   rate_key (key of a time_rate counter this derives from),
   split_fractions (object mapping output counter keys to fractions, e.g. {"deaths": 0.12, "transported": 0.4}).

5. "state_effect" — changed only by inject state_effects (external events). The engine never auto-updates it.

6. "static" — set at scenario start, never changes (e.g. total_evacuees). Used as caps or reference values.`;

/**
 * Generate scenario-appropriate CounterDefinition[] for each team using AI.
 * For minimal complexity, returns undefined (template-based fallback used instead).
 */
async function generateCounterDefinitions(
  input: WarroomGenerateInput,
  teamNames: string[],
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<Record<string, CounterDefinition[]> | undefined> {
  if (input.complexity_tier === 'minimal') return undefined;

  onProgress?.('Generating team counter definitions...');

  const { scenario_type, setting, venue_name, location } = input;
  const venue = venue_name || location || setting;

  const systemPrompt = `You are an expert crisis management scenario designer. You must define the METRICS (counters) that each team will track during a "${scenario_type}" training exercise.

Scenario: ${narrative?.title || scenario_type}
Venue: ${venue}
Setting: ${setting}
Teams: ${teamNames.join(', ')}
${narrative?.description ? `\nDescription: ${narrative.description}` : ''}

${COUNTER_BEHAVIOR_CATALOG}

RULES:
- Each team should have 3–8 counters that are RELEVANT to this specific scenario type and team role.
- Do NOT include counters that don't make sense (e.g. "evacuated_count" for a negotiation team in a kidnapping, or "inner_cordon_radius_m" for a media team).
- Every team MUST have at least one "decision_toggle" counter (a key milestone the team should achieve).
- Teams that manage people/resources over time should have "time_rate" counters.
- Use "static" for fixed reference values (caps, totals).
- Use "derived" for counters computed from others (e.g. patients_waiting = pool - processed).
- visible_to should be "all" for most counters; use "trainer_only" for internal flags players shouldn't see.
- Counter keys must be snake_case, unique within each team.
- Labels should be short, human-readable (e.g. "People Evacuated", "Perimeter Established").
- For decision_toggle and decision_increment, provide realistic keywords that would appear in a player's decision text.

Return ONLY valid JSON:
{
  "counter_definitions": {
    "<team_name>": [
      {
        "key": "snake_case_key",
        "label": "Human Readable Label",
        "type": "number|boolean|enum",
        "initial_value": 0,
        "behavior": "time_rate|decision_toggle|decision_increment|derived|state_effect|static",
        "visible_to": "all|trainer_only",
        "config": { ... }
      }
    ]
  }
}`;

  const userPrompt = `Define counter definitions for each team in "${narrative?.title || scenario_type}" at ${venue}. Teams: ${teamNames.join(', ')}.`;

  try {
    const parsed = await callOpenAi<{
      counter_definitions?: Record<string, CounterDefinition[]>;
    }>(systemPrompt, userPrompt, openAiApiKey, 4000);

    if (!parsed.counter_definitions || typeof parsed.counter_definitions !== 'object') {
      return undefined;
    }

    // Validate: ensure every definition has required fields
    for (const [team, defs] of Object.entries(parsed.counter_definitions)) {
      if (!Array.isArray(defs)) {
        delete parsed.counter_definitions[team];
        continue;
      }
      parsed.counter_definitions[team] = defs
        .filter(
          (d) =>
            d &&
            typeof d.key === 'string' &&
            typeof d.label === 'string' &&
            ['number', 'boolean', 'enum'].includes(d.type) &&
            [
              'time_rate',
              'decision_toggle',
              'decision_increment',
              'derived',
              'state_effect',
              'static',
            ].includes(d.behavior),
        )
        .map((d) => {
          if (d.initial_value != null && typeof d.initial_value === 'object') {
            d.initial_value = d.type === 'number' ? 0 : d.type === 'boolean' ? false : '';
          }
          return d;
        });
    }

    enrichWithStandardDecisionIntentKeys(parsed.counter_definitions, teamNames);

    return Object.keys(parsed.counter_definitions).length > 0
      ? parsed.counter_definitions
      : undefined;
  } catch (err) {
    logger.warn({ err }, 'Counter definitions generation failed; continuing without');
    return undefined;
  }
}

const STANDARD_DECISION_INTENT_KEYS: Record<string, CounterDefinition[]> = {
  evacuation_state: [
    {
      key: 'zone_identification_decided',
      label: 'Zone Identification',
      type: 'boolean',
      initial_value: false,
      behavior: 'decision_toggle',
      visible_to: 'trainer_only',
    },
    {
      key: 'flow_control_decided',
      label: 'Flow Control Established',
      type: 'boolean',
      initial_value: false,
      behavior: 'decision_toggle',
      visible_to: 'trainer_only',
    },
  ],
  triage_state: [
    {
      key: 'prioritisation_decided',
      label: 'Triage Prioritisation Set',
      type: 'boolean',
      initial_value: false,
      behavior: 'decision_toggle',
      visible_to: 'trainer_only',
    },
    {
      key: 'supply_request_made',
      label: 'Supply Request Made',
      type: 'boolean',
      initial_value: false,
      behavior: 'decision_toggle',
      visible_to: 'trainer_only',
    },
    {
      key: 'patient_privacy_decided',
      label: 'Patient Privacy Managed',
      type: 'boolean',
      initial_value: false,
      behavior: 'decision_toggle',
      visible_to: 'trainer_only',
    },
    {
      key: 'perimeter_security_decided',
      label: 'Triage Perimeter Security',
      type: 'boolean',
      initial_value: false,
      behavior: 'decision_toggle',
      visible_to: 'trainer_only',
    },
    {
      key: 'triage_zone_established',
      label: 'Triage Zone Established',
      type: 'boolean',
      initial_value: false,
      behavior: 'decision_toggle',
      visible_to: 'trainer_only',
    },
  ],
  media_state: [
    {
      key: 'first_statement_issued',
      label: 'Public Statement Issued',
      type: 'boolean',
      initial_value: false,
      behavior: 'decision_toggle',
      visible_to: 'trainer_only',
    },
    {
      key: 'spokesperson_designated',
      label: 'Spokesperson Designated',
      type: 'boolean',
      initial_value: false,
      behavior: 'decision_toggle',
      visible_to: 'trainer_only',
    },
  ],
  police_state: [
    {
      key: 'perimeter_established',
      label: 'Perimeter Established',
      type: 'boolean',
      initial_value: false,
      behavior: 'decision_toggle',
      visible_to: 'trainer_only',
    },
  ],
};

function teamNameToStateKey(teamName: string): string {
  const lower = teamName.toLowerCase();
  if (lower.includes('evacuation') || lower.includes('evac')) return 'evacuation_state';
  if (lower.includes('triage') || lower.includes('medical') || lower.includes('medic'))
    return 'triage_state';
  if (
    lower.includes('media') ||
    lower.includes('comms') ||
    lower.includes('communication') ||
    lower.includes('public')
  )
    return 'media_state';
  if (lower.includes('police') || lower.includes('security') || lower.includes('law'))
    return 'police_state';
  if (lower.includes('fire') || lower.includes('hazard') || lower.includes('hazmat'))
    return 'fire_state';
  return lower.replaceAll(' ', '_').replaceAll('-', '_') + '_state';
}

function enrichWithStandardDecisionIntentKeys(
  counterDefs: Record<string, CounterDefinition[]>,
  teamNames: string[],
): void {
  for (const teamName of teamNames) {
    const stateKey = teamNameToStateKey(teamName);
    const standardKeys = STANDARD_DECISION_INTENT_KEYS[stateKey];
    if (!standardKeys) continue;

    if (!counterDefs[teamName]) counterDefs[teamName] = [];

    const existingKeys = new Set(counterDefs[teamName].map((d) => d.key));
    for (const def of standardKeys) {
      if (!existingKeys.has(def.key)) {
        counterDefs[teamName].push(def);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 4a-1 — Scenario-Fixed Pins  (incident, exits, cordons — anchored to building outline)
// ---------------------------------------------------------------------------

async function generateScenarioFixedPins(
  input: WarroomGenerateInput,
  teamNames: string[],
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<WarroomScenarioPayload['locations']> {
  if (input.complexity_tier === 'minimal') return undefined;

  onProgress?.('Generating scenario-fixed map pins...');

  const { scenario_type, setting, terrain, venue_name, location, geocode, osmBuildings } = input;
  const venue = venue_name || location || setting;
  const coords = geocode
    ? `Venue geocode (approximate center of the venue — NOT necessarily the incident location): ${geocode.lat}, ${geocode.lng}`
    : '';

  let buildingBlock = '';
  if (osmBuildings && osmBuildings.length > 0) {
    const lines = osmBuildings.map((b, i) => {
      const nameStr = b.name ? `"${b.name}"` : '(unnamed)';
      const boundsStr = b.bounds
        ? `spans [${b.bounds.minlat.toFixed(5)},${b.bounds.minlon.toFixed(5)}] to [${b.bounds.maxlat.toFixed(5)},${b.bounds.maxlon.toFixed(5)}]`
        : `center [${b.lat.toFixed(5)},${b.lng.toFixed(5)}]`;
      return `  ${i + 1}. ${nameStr} — ${boundsStr}, ${b.distance_from_center_m}m from incident`;
    });
    buildingBlock = `\nREAL BUILDING OUTLINES (from OpenStreetMap — use these to place exit pins at the actual building perimeter):\n${lines.join('\n')}`;
  }

  const narrativeBlock = narrative
    ? `\n\nSCENARIO NARRATIVE:\nTitle: ${narrative.title || ''}\nDescription: ${narrative.description || ''}\nBriefing: ${narrative.briefing || ''}`
    : '';

  const systemPrompt = `You are an expert crisis management scenario designer placing scenario-fixed pins on a real map.

Scenario type: ${scenario_type}
Venue: ${venue}
Setting: ${setting}
Terrain: ${terrain}
Teams: ${teamNames.join(', ')}
${coords}
${buildingBlock}
${narrativeBlock}

Generate SCENARIO-FIXED pins: the incident site and all potential entry/exit points at the venue.

IMPORTANT: Before generating pins, read the scenario narrative carefully to determine WHERE the incident actually occurs within the venue. The venue geocode is just the approximate center of the venue — the actual incident may be in a car park, a specific wing, an outdoor area, or any sub-location described in the narrative. Place pins relative to the ACTUAL incident location, not the venue center.

PIN CATEGORIES (only these two):
- incident_site (1 pin): Determine the EXACT crisis location from the scenario narrative. If the narrative describes an incident at a specific part of the venue (e.g. "car bomb in the car park", "explosion on the runway", "fire in the loading dock", "shooting in the lobby"), place the pin at THAT specific location — not at the main building center. Use the building outlines to identify which structure or area matches the narrative. Only default to the main building center if the narrative does not specify a sub-location within the venue.
- entry_exit (4-8 pins): ALL potential entry/exit points at the venue that response teams could use. These are NEUTRAL — teams will claim them during gameplay. Include building exits, service entrances, loading docks, emergency exits, vehicle access gates, pedestrian paths. For building incidents: place at the building perimeter where doors meet roads or open areas. For outdoor incidents: place at vehicle exits, pedestrian gates, or emergency paths. If building bounds are provided, place exit coordinates ON or VERY NEAR the building boundary edges.

CONDITIONS per pin type:
- entry_exit: { width_m, surface, capacity_flow_per_min, is_blocked, lighting, accessibility, distance_from_incident_m, exit_type (e.g. "double_door", "loading_dock", "vehicle_gate", "emergency_exit", "pedestrian_path"), notes }
- incident_site: { area_m2, structural_damage, hazards[], accessibility, casualty_density, notes }

Do NOT generate hospital, police station, fire station, candidate-space, or cordon pins. Cordons are placed by players during gameplay.

SPATIAL RULES:
- Incident site pins: first read the scenario narrative to determine WHERE exactly the incident occurs, then place the pin at that specific location. This may be inside a building, in a car park, on an airfield, at a loading dock, or any location described in the briefing — do NOT default to the main building center.
- Entry/exit pins: MUST be at real building exits, gates, or access paths. NOT floating in open space away from any structure.
- All coordinates must be realistic for the venue geography

Return ONLY valid JSON:
{ "locations": [ { "location_type": "string", "pin_category": "string", "description": "string", "label": "string (max 5 words)", "coordinates": { "lat": 0.0, "lng": 0.0 }, "conditions": {}, "display_order": 1 } ] }`;

  const userPrompt = `Place scenario-fixed pins (incident site + all entry/exit points) for "${narrative?.title || scenario_type}" at ${venue}.`;

  try {
    const parsed = await callOpenAi<{ locations?: WarroomScenarioPayload['locations'] }>(
      systemPrompt,
      userPrompt,
      openAiApiKey,
      2000,
    );
    return parsed.locations?.length ? parsed.locations : undefined;
  } catch (err) {
    logger.warn({ err }, 'Phase 4a-1 scenario-fixed pins failed; continuing without');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Post-processing — validate pin spatial topology
// ---------------------------------------------------------------------------

function validatePinTopology(
  pins: NonNullable<WarroomScenarioPayload['locations']>,
  incidentCenter?: { lat: number; lng: number },
  osmOpenSpaces?: OsmOpenSpace[],
): NonNullable<WarroomScenarioPayload['locations']> {
  if (!incidentCenter || pins.length === 0) return pins;

  // Compute distance_from_incident_m for every pin
  for (const pin of pins) {
    const dist = Math.round(
      haversineDistance(
        incidentCenter.lat,
        incidentCenter.lng,
        pin.coordinates.lat,
        pin.coordinates.lng,
      ),
    );
    if (!pin.conditions) pin.conditions = {};
    if (pin.conditions.distance_from_incident_m == null) {
      pin.conditions.distance_from_incident_m = dist;
    }
  }

  // Find the outermost exit pin distance
  let maxExitDist = 0;
  for (const pin of pins) {
    const cat = pin.pin_category || (pin.conditions?.pin_category as string);
    if (cat === 'access') {
      const d = pin.conditions?.distance_from_incident_m as number;
      if (d > maxExitDist) maxExitDist = d;
    }
  }

  // Validate candidate spaces are further than exits
  let topologyWarnings = 0;
  for (const pin of pins) {
    const cat = pin.pin_category || (pin.conditions?.pin_category as string);
    if (cat !== 'candidate_space') continue;
    const d = pin.conditions?.distance_from_incident_m as number;
    if (maxExitDist > 0 && d < maxExitDist) {
      topologyWarnings++;
    }
  }
  if (topologyWarnings > 0) {
    logger.warn(
      { count: topologyWarnings, maxExitDist },
      'Candidate spaces closer to incident than outermost exit — topology violation',
    );
  }

  // Validate candidate space coordinates match an OSM open space within 50m
  if (osmOpenSpaces && osmOpenSpaces.length > 0) {
    let matchCount = 0;
    let missCount = 0;
    for (const pin of pins) {
      const cat = pin.pin_category || (pin.conditions?.pin_category as string);
      if (cat !== 'candidate_space') continue;
      const matched = osmOpenSpaces.some(
        (s) => haversineDistance(pin.coordinates.lat, pin.coordinates.lng, s.lat, s.lng) < 50,
      );
      if (matched) matchCount++;
      else missCount++;
    }
    logger.info(
      { matched: matchCount, unmatched: missCount },
      'Candidate space OSM coordinate matching',
    );
  }

  return pins;
}

// ---------------------------------------------------------------------------
// Phase 4a-POI — Generate POI pins from OSM data with AI-enriched conditions
// ---------------------------------------------------------------------------

interface PoiStub {
  location_type: 'hospital' | 'police_station' | 'fire_station';
  pin_category: 'poi';
  label: string;
  coordinates: { lat: number; lng: number };
  distance_from_incident_m: number;
}

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function generatePoiPinsFromOsm(
  osmVicinity: OsmVicinity | undefined,
  scenarioType: string,
  venue: string,
  incidentCoords: { lat: number; lng: number } | undefined,
  openAiApiKey: string,
): Promise<NonNullable<WarroomScenarioPayload['locations']>> {
  if (!osmVicinity) return [];

  const stubs: PoiStub[] = [];
  const center = incidentCoords ?? osmVicinity.center ?? { lat: 0, lng: 0 };

  for (const h of osmVicinity.hospitals ?? []) {
    stubs.push({
      location_type: 'hospital',
      pin_category: 'poi',
      label: h.name || 'Hospital',
      coordinates: { lat: h.lat, lng: h.lng },
      distance_from_incident_m: Math.round(haversineDistance(center.lat, center.lng, h.lat, h.lng)),
    });
  }
  for (const p of osmVicinity.police ?? []) {
    stubs.push({
      location_type: 'police_station',
      pin_category: 'poi',
      label: p.name || 'Police Station',
      coordinates: { lat: p.lat, lng: p.lng },
      distance_from_incident_m: Math.round(haversineDistance(center.lat, center.lng, p.lat, p.lng)),
    });
  }
  for (const f of osmVicinity.fire_stations ?? []) {
    stubs.push({
      location_type: 'fire_station',
      pin_category: 'poi',
      label: f.name || 'Fire Station',
      coordinates: { lat: f.lat, lng: f.lng },
      distance_from_incident_m: Math.round(haversineDistance(center.lat, center.lng, f.lat, f.lng)),
    });
  }

  if (stubs.length === 0) return [];

  const POI_CAPS: Record<string, number> = { hospital: 5, police_station: 3, fire_station: 3 };
  const byType: Record<string, PoiStub[]> = {};
  for (const s of stubs) {
    (byType[s.location_type] ??= []).push(s);
  }
  const capped: PoiStub[] = [];
  for (const [type, items] of Object.entries(byType)) {
    items.sort((a, b) => a.distance_from_incident_m - b.distance_from_incident_m);
    capped.push(...items.slice(0, POI_CAPS[type] ?? 5));
  }
  capped.sort((a, b) => a.distance_from_incident_m - b.distance_from_incident_m);
  const cappedStubs = capped;

  const stubSummary = cappedStubs
    .map(
      (s, i) =>
        `${i + 1}. [${s.location_type}] "${s.label}" — ${s.distance_from_incident_m}m from incident`,
    )
    .join('\n');

  const systemPrompt = `You are an expert in emergency facility capabilities. Given a list of real facilities near a ${scenarioType} incident at ${venue}, estimate realistic operational conditions for each.

Facilities:
${stubSummary}

For each facility (by index), return conditions as JSON:

For hospitals: { facility_type: "tertiary_hospital"|"general_hospital"|"community_hospital"|"clinic", trauma_center_level?: "Level 1"|"Level 2"|"Level 3", bed_capacity: number, emergency_beds_available: number, has_helipad: boolean, ambulance_bays: number, specializations: string[], estimated_response_time_min: number, notes: string }

For police_station: { facility_type: "division_hq"|"district_station"|"neighbourhood_post"|"tactical_base", available_officers_estimate: number, has_tactical_unit: boolean, has_k9_unit: boolean, has_negotiation_team: boolean, estimated_response_time_min: number, notes: string }

For fire_station: { facility_type: "headquarters"|"standard_station"|"substation", appliance_count: number, has_hazmat_unit: boolean, has_rescue_unit: boolean, has_aerial_platform: boolean, estimated_response_time_min: number, notes: string }

ENVIRONMENTAL CHALLENGES:
For each facility, also generate an "environmental_challenges" array with 0-2 realistic operational challenges that responders would face. NOT every facility has a problem — leave the array empty for facilities with no issues (at least half should have none). Challenges make the scenario more realistic and test player adaptability.

Challenge types: "traffic_congestion", "at_capacity", "power_outage", "road_closure", "equipment_shortage", "structural_damage", "staffing_shortage", "communication_failure"

Each challenge: { challenge_type: string, description: string (1-2 sentences, specific and actionable), severity: "high"|"medium"|"low", affected_route?: string (if traffic/road related), alternative?: string (workaround hint, e.g. alternate route name) }

Examples:
- Hospital closest to incident: { challenge_type: "traffic_congestion", description: "Main access via Bayfront Avenue is gridlocked due to emergency vehicle convergence and fleeing pedestrians.", severity: "high", affected_route: "Bayfront Avenue", alternative: "Approach via Sheares Avenue from the south" }
- Hospital at capacity: { challenge_type: "at_capacity", description: "Emergency department already handling mass casualty patients from a separate industrial accident. Only 3 trauma bays available.", severity: "medium" }
- Fire station with equipment issue: { challenge_type: "equipment_shortage", description: "Primary aerial platform undergoing maintenance. Only ground-level appliances available.", severity: "low" }

Return ONLY valid JSON: { "facilities": [ { "index": 1, "conditions": { ..., "environmental_challenges": [...] } } ] }
Base response times on distance. Use the facility name to infer size/capabilities where possible.`;

  try {
    const parsed = await callOpenAi<{
      facilities?: Array<{ index: number; conditions: Record<string, unknown> }>;
    }>(
      systemPrompt,
      `Enrich ${cappedStubs.length} facilities for a ${scenarioType} response.`,
      openAiApiKey,
      6000,
    );

    const enriched = parsed.facilities ?? [];
    const conditionsMap = new Map<number, Record<string, unknown>>();
    for (const f of enriched) {
      if (typeof f.index === 'number' && f.conditions) {
        conditionsMap.set(f.index, f.conditions);
      }
    }

    return cappedStubs.map((stub, i) => {
      const aiConditions = conditionsMap.get(i + 1) ?? {};
      return {
        location_type: stub.location_type,
        pin_category: stub.pin_category as string,
        label: stub.label,
        description: `${stub.location_type.replace(/_/g, ' ')} — ${stub.distance_from_incident_m}m from incident`,
        coordinates: stub.coordinates,
        conditions: {
          distance_from_incident_m: stub.distance_from_incident_m,
          ...aiConditions,
        },
        display_order: 100 + i,
      };
    });
  } catch (err) {
    logger.warn(
      { err, count: cappedStubs.length },
      'POI enrichment failed; using stubs with distance only',
    );
    return cappedStubs.map((stub, i) => ({
      location_type: stub.location_type,
      pin_category: stub.pin_category as string,
      label: stub.label,
      description: `${stub.location_type.replace(/_/g, ' ')} — ${stub.distance_from_incident_m}m from incident`,
      coordinates: stub.coordinates,
      conditions: { distance_from_incident_m: stub.distance_from_incident_m },
      display_order: 100 + i,
    }));
  }
}

// ---------------------------------------------------------------------------
// Phase 4b — Route Network (corridor computation + AI enrichment)
// ---------------------------------------------------------------------------

interface RouteCorridor {
  route_id: string;
  label: string;
  highway_type: string;
  one_way: boolean;
  geometry: [number, number][];
  distance_m: number;
  baseline_travel_min: number;
  connects_to: string[];
}

const HIGHWAY_SPEED_KPH: Record<string, number> = {
  motorway: 80,
  trunk: 60,
  primary: 50,
  secondary: 40,
  tertiary: 30,
  residential: 20,
  unclassified: 25,
};

function polylineLength(coords: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += geoHaversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }
  return total;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Deterministic corridor computation: link OSM road polylines to nearby
 * facilities (hospitals, police, fire) and the incident site.
 */
function computeRouteCorridors(
  routeGeometries: OsmRouteGeometry[],
  facilities: Array<{
    label: string;
    coordinates: { lat: number; lng: number };
    location_type: string;
  }>,
  incidentCoords: { lat: number; lng: number },
): RouteCorridor[] {
  const PROXIMITY_THRESHOLD_M = 6000;
  const corridors: RouteCorridor[] = [];
  const seenIds = new Set<string>();

  for (const route of routeGeometries) {
    if (!route.coordinates?.length || route.coordinates.length < 2) continue;

    const routeId = slugify(route.name);
    if (seenIds.has(routeId)) continue;
    seenIds.add(routeId);

    const nearIncident = route.coordinates.some(
      ([lat, lng]) =>
        geoHaversineM(lat, lng, incidentCoords.lat, incidentCoords.lng) < PROXIMITY_THRESHOLD_M,
    );
    if (!nearIncident) continue;

    const connectsTo: string[] = [];
    for (const facility of facilities) {
      const nearFacility = route.coordinates.some(
        ([lat, lng]) =>
          geoHaversineM(lat, lng, facility.coordinates.lat, facility.coordinates.lng) <
          PROXIMITY_THRESHOLD_M,
      );
      if (nearFacility) connectsTo.push(facility.label);
    }

    const lengthM = polylineLength(route.coordinates);
    const speedKph = HIGHWAY_SPEED_KPH[route.highway_type] ?? 30;
    const travelMin = Math.round((lengthM / 1000 / speedKph) * 60 * 10) / 10;

    const suffix = connectsTo.length > 0 ? ` – toward ${connectsTo[0]}` : '';
    corridors.push({
      route_id: routeId,
      label: `${route.name}${suffix}`,
      highway_type: route.highway_type,
      one_way: route.one_way,
      geometry: route.coordinates,
      distance_m: Math.round(lengthM),
      baseline_travel_min: Math.max(1, travelMin),
      connects_to: connectsTo,
    });
  }

  corridors.sort((a, b) => a.baseline_travel_min - b.baseline_travel_min);
  return corridors.slice(0, 12);
}

/**
 * AI enrichment: assign traffic conditions to route corridors and return
 * them as scenario_locations rows (location_type = 'route', pin_category = 'route').
 */
async function enrichRouteLocations(
  input: WarroomGenerateInput,
  corridors: RouteCorridor[],
  facilities: Array<{ label: string; location_type: string; conditions?: Record<string, unknown> }>,
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<WarroomScenarioPayload['locations']> {
  if (corridors.length === 0) return undefined;

  onProgress?.('Enriching route network with traffic conditions...');

  const { scenario_type, venue_name, location, setting } = input;
  const venue = venue_name || location || setting;

  const corridorSummary = corridors
    .map(
      (c, i) =>
        `${i + 1}. "${c.label}" [route_id: "${c.route_id}"] (${c.highway_type}, ${c.distance_m}m, ~${c.baseline_travel_min} min)${c.one_way ? ' [one-way]' : ''}${c.connects_to.length > 0 ? ` → connects to: ${c.connects_to.join(', ')}` : ''}`,
    )
    .join('\n');

  const facilitySummary = facilities
    .filter((f) => f.location_type === 'hospital')
    .map((f) => {
      const conds = f.conditions as Record<string, unknown> | undefined;
      const beds = conds?.emergency_beds_available ?? '?';
      return `- ${f.label} (${beds} emergency beds)`;
    })
    .join('\n');

  const systemPrompt = `You are an expert in urban traffic management during crisis incidents. Given real road corridors near a ${scenario_type} incident at ${venue}, assign realistic traffic conditions to each route.

ROAD CORRIDORS (computed from real OpenStreetMap data):
${corridorSummary}

HOSPITALS:
${facilitySummary}

SCENARIO: ${narrative?.title ?? scenario_type} — ${narrative?.description ?? ''}

For each route, assign a condition. Not every route has a problem — at least half should be clear.
Problems must be specific and scenario-appropriate (not generic). Reference real road names.

Return ONLY valid JSON:
{
  "routes": [
    {
      "route_id": "string (use the exact route_id from input)",
      "label": "string (use the exact label from input)",
      "travel_time_minutes": number (baseline if clear, inflated 2-4x if congested, null if impassable),
      "problem": null or "string describing the specific issue (e.g. 'Multi-vehicle accident blocking 2 lanes', 'Emergency vehicle convergence causing gridlock')",
      "managed": boolean (true if clear, false if problem exists),
      "connects_to": ["facility labels this road passes near"],
      "is_optimal_for": ["facility labels this is the best route to"]
    }
  ]
}`;

  const userPrompt = `Assign traffic conditions for "${narrative?.title || scenario_type}" at ${venue}. ${corridors.length} routes to enrich.`;

  try {
    const parsed = await callOpenAi<{
      routes?: Array<{
        route_id: string;
        label: string;
        travel_time_minutes: number | null;
        problem: string | null;
        managed: boolean;
        connects_to?: string[];
        is_optimal_for?: string[];
      }>;
    }>(systemPrompt, userPrompt, openAiApiKey, 3000);

    if (!parsed.routes?.length) {
      logger.warn('Route enrichment AI returned no routes; using corridor stubs');
      return corridors.map((c, i) => corridorToLocation(c, i));
    }

    const corridorMap = new Map(corridors.map((c) => [c.route_id, c]));

    return parsed.routes.map((r, i) => {
      const corridor = corridorMap.get(r.route_id);
      const midpoint = corridor
        ? corridor.geometry[Math.floor(corridor.geometry.length / 2)]
        : [0, 0];
      return {
        location_type: 'route',
        pin_category: 'route',
        label: r.label || corridor?.label || 'Route',
        description: r.problem || 'Clear route',
        coordinates: { lat: midpoint[0], lng: midpoint[1] },
        conditions: {
          route_id: r.route_id,
          highway_type: corridor?.highway_type,
          one_way: corridor?.one_way ?? false,
          distance_m: corridor?.distance_m,
          baseline_travel_min: corridor?.baseline_travel_min,
          travel_time_minutes: r.travel_time_minutes,
          problem: r.problem,
          managed: r.managed,
          connects_to: r.connects_to ?? corridor?.connects_to ?? [],
          is_optimal_for: r.is_optimal_for ?? [],
          geometry: corridor?.geometry,
        },
        display_order: 200 + i,
      };
    });
  } catch (err) {
    logger.warn({ err }, 'Route enrichment failed; using corridor stubs');
    return corridors.map((c, i) => corridorToLocation(c, i));
  }
}

function corridorToLocation(
  c: RouteCorridor,
  i: number,
): NonNullable<WarroomScenarioPayload['locations']>[number] {
  const midpoint = c.geometry[Math.floor(c.geometry.length / 2)] ?? [0, 0];
  return {
    location_type: 'route',
    pin_category: 'route',
    label: c.label,
    description: `${c.highway_type} road — ${c.distance_m}m`,
    coordinates: { lat: midpoint[0], lng: midpoint[1] },
    conditions: {
      route_id: c.route_id,
      highway_type: c.highway_type,
      one_way: c.one_way,
      distance_m: c.distance_m,
      baseline_travel_min: c.baseline_travel_min,
      travel_time_minutes: c.baseline_travel_min,
      problem: null,
      managed: true,
      connects_to: c.connects_to,
      is_optimal_for: [],
      geometry: c.geometry,
    },
    display_order: 200 + i,
  };
}

// ---------------------------------------------------------------------------
// Phase 4b2 — Step 1: Hazard Identification  (2 500 tokens)
// ---------------------------------------------------------------------------

async function generateScenarioHazards(
  input: WarroomGenerateInput,
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
  locations?: WarroomScenarioPayload['locations'],
  teamNames?: string[],
): Promise<WarroomScenarioPayload['hazards']> {
  const includeHazards = input.complexity_tier === 'full' || input.complexity_tier === 'rich';
  if (!includeHazards) return undefined;

  onProgress?.('Identifying hazards (step 1)...');

  const { scenario_type, setting, venue_name, location, researchContext } = input;
  const venue = venue_name || location || setting;

  const similarCasesBlock =
    researchContext?.similar_cases && researchContext.similar_cases.length > 0
      ? `\nSIMILAR REAL INCIDENTS (for hazard reference):\n${similarCasesToPromptBlock(researchContext.similar_cases)}`
      : '';

  const incidentSites =
    locations?.filter(
      (l) =>
        l.pin_category === 'incident_site' ||
        l.location_type.toLowerCase().includes('blast') ||
        l.location_type.toLowerCase().includes('epicentre'),
    ) ?? [];

  const incidentBlock =
    incidentSites.length > 0
      ? `Incident sites:\n${incidentSites.map((s) => `- ${s.label} at (${s.coordinates.lat}, ${s.coordinates.lng})`).join('\n')}`
      : '';

  const threatProfile = input.threat_profile;
  const rules = threatProfile ? getThreatHazardRules(threatProfile.weapon_class) : null;
  const threatBlock = await buildThreatProfileBlock(
    threatProfile,
    openAiApiKey,
    researchContext?.similar_cases,
  );
  const minHazards = rules?.min_hazards ?? 8;
  const maxHazards = rules?.max_hazards ?? 15;
  const allowedHazardTypes = rules?.allowed_hazards ?? [
    'fire',
    'chemical_spill',
    'structural_collapse',
    'debris',
    'gas_leak',
    'flood',
    'biological',
    'explosion',
    'electrical',
    'smoke',
  ];

  const systemPrompt = `You are an expert crisis management scenario designer identifying hazards for a realistic training exercise.

Scenario type: ${scenario_type}
Venue: ${venue}
Setting: ${setting}
${narrative ? `Narrative: ${narrative.title}\nDescription: ${narrative.description}\nBriefing: ${narrative.briefing || ''}` : ''}
${incidentBlock}
Teams available: ${(teamNames ?? []).join(', ') || 'not specified'}
${threatBlock}${similarCasesBlock}
${
  minHazards === 0
    ? `This incident type may produce NO environmental hazards at all. Only generate hazards if the weapon/scenario can physically cause them. It is acceptable to return an empty hazards array.`
    : `Research the venue and scenario type to identify realistic hazards that would result from this incident. Consider:
- What materials are at this venue that this weapon could interact with?
- What REALISTIC damage would a ${threatProfile?.weapon_type || scenario_type} cause?
- Only include secondary hazards that can physically result from the primary attack method.`
}

Generate ${minHazards}-${maxHazards} hazards. ${minHazards === 0 ? 'Return 0 if the weapon cannot cause environmental hazards.' : 'Each hazard is a DISTINCT danger at a SPECIFIC location.'}

Return ONLY valid JSON:
{
  "hazards": [
    {
      "hazard_type": "${allowedHazardTypes.join('|')}",
      "location_lat": number,
      "location_lng": number,
      "floor_level": "G",
      "properties": {
        "size": "small|medium|large",
        "fuel_source": "what is burning/leaking/collapsed",
        "adjacent_risks": ["risk1", "risk2"],
        "wind_exposure": true/false,
        "casualties_visible": number,
        "access_blocked": true/false,
        "venue_material_context": "what venue-specific materials are involved"
      },
      "assessment_criteria": ["criteria1", "criteria2"],
      "status": "active",
      "appears_at_minutes": 0
    }
  ]
}

RULES:
- ONLY use hazard_type values from this list: ${allowedHazardTypes.join(', ')}. Do NOT generate types outside this list.
- Hazards must be near or at the incident sites (within 300m)
${minHazards >= 4 ? `- At least ${Math.ceil(minHazards / 2)} immediate hazards (appears_at_minutes: 0) and the rest as delayed hazards` : minHazards > 0 ? '- Hazards should appear at realistic times' : '- Only generate hazards the weapon can physically cause'}
- Include venue-specific material detail in properties.fuel_source and venue_material_context
- Locations must be realistic coordinates near the incident sites`;

  const userPrompt = `Identify all hazards from "${narrative?.title || scenario_type}" at ${venue}. Research what materials and infrastructure exist at this type of venue.`;

  try {
    const parsed = await callOpenAi<{
      hazards?: WarroomScenarioPayload['hazards'];
    }>(systemPrompt, userPrompt, openAiApiKey, 4000);
    const stubs = parsed.hazards?.length ? parsed.hazards : undefined;
    if (!stubs?.length) return undefined;

    onProgress?.(`Enriching ${stubs.length} hazards in parallel (step 2)...`);
    const enriched = await Promise.all(
      stubs.map((h) => enrichHazardDetail(h, input, openAiApiKey, narrative, teamNames)),
    );
    return enriched;
  } catch (err) {
    logger.warn({ err }, 'Hazard identification failed; continuing without');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Phase 4b2 — Step 2: Deep Hazard Enrichment  (5 000 tokens each, parallel)
// ---------------------------------------------------------------------------

async function enrichHazardDetail(
  hazard: NonNullable<WarroomScenarioPayload['hazards']>[number],
  input: WarroomGenerateInput,
  openAiApiKey: string,
  narrative?: { title?: string; description?: string; briefing?: string },
  teamNames?: string[],
): Promise<NonNullable<WarroomScenarioPayload['hazards']>[number]> {
  const { scenario_type, setting, venue_name, location } = input;
  const venue = venue_name || location || setting;

  const hazardContext = `Scenario: ${scenario_type} at ${venue}
${narrative ? `Narrative: ${narrative.title} — ${narrative.description}` : ''}
Hazard type: ${hazard.hazard_type}
Location: (${hazard.location_lat}, ${hazard.location_lng}), floor ${hazard.floor_level}
Size: ${(hazard.properties as Record<string, unknown>).size || 'unknown'}
Fuel/source: ${(hazard.properties as Record<string, unknown>).fuel_source || 'unknown'}
Adjacent risks: ${JSON.stringify((hazard.properties as Record<string, unknown>).adjacent_risks || [])}
Teams available: ${(teamNames ?? []).join(', ') || 'not specified'}`;

  // Run three focused calls in parallel (zones are now unified per-incident, not per-hazard)
  const [descResult, reqsResult, deteriorationResult] = await Promise.all([
    enrichHazardDescription(hazardContext, hazard, venue, openAiApiKey),
    enrichHazardRequirements(hazardContext, hazard, venue, openAiApiKey),
    enrichHazardDeterioration(hazardContext, hazard, venue, openAiApiKey),
  ]);

  return {
    ...hazard,
    enriched_description: descResult.enriched_description ?? undefined,
    fire_class: descResult.fire_class ?? undefined,
    debris_type: descResult.debris_type ?? undefined,
    resolution_requirements: {
      ...(reqsResult.resolution_requirements ?? {}),
      ideal_response_sequence: reqsResult.ideal_response_sequence ?? [],
      required_ppe: reqsResult.required_ppe ?? [],
      estimated_resolution_minutes: reqsResult.estimated_resolution_minutes ?? null,
    },
    personnel_requirements: reqsResult.personnel_requirements ?? {},
    equipment_requirements: reqsResult.equipment_requirements ?? [],
    deterioration_timeline: deteriorationResult.deterioration_timeline ?? {},
    zones: [],
  };
}

// Sub-call 1: Description, fire class, debris type
async function enrichHazardDescription(
  hazardContext: string,
  hazard: NonNullable<WarroomScenarioPayload['hazards']>[number],
  venue: string,
  openAiApiKey: string,
): Promise<{ enriched_description?: string; fire_class?: string; debris_type?: string }> {
  const systemPrompt = `You are an expert hazard assessment specialist. Describe this hazard in vivid, realistic detail.

${hazardContext}

Provide:
1. ENRICHED DESCRIPTION: A detailed paragraph (200+ words) describing the hazard condition — what it looks like, smells like, sounds like. What a responder approaching would see. Include venue-specific materials (gas lines, glass facades, chemical storage, fuel tanks, electrical systems).
2. FIRE CLASS (if fire): A (ordinary combustibles), B (flammable liquids/gases), C (electrical), D (metals), K (cooking oils). null if not a fire.
3. DEBRIS TYPE (if structural/collapse): concrete, steel, glass, wood, mixed. null if not debris/collapse.

Return ONLY valid JSON:
{
  "enriched_description": "detailed paragraph...",
  "fire_class": "A|B|C|D|K" or null,
  "debris_type": "concrete|steel|glass|wood|mixed" or null
}`;

  try {
    return await callOpenAi<{
      enriched_description?: string;
      fire_class?: string;
      debris_type?: string;
    }>(
      systemPrompt,
      `Describe the ${hazard.hazard_type} hazard at ${venue} in vivid detail.`,
      openAiApiKey,
      2000,
    );
  } catch (err) {
    logger.warn({ err, hazardType: hazard.hazard_type }, 'Hazard description enrichment failed');
    return {};
  }
}

// Sub-call 2: Resolution, personnel, and equipment requirements
async function enrichHazardRequirements(
  hazardContext: string,
  hazard: NonNullable<WarroomScenarioPayload['hazards']>[number],
  venue: string,
  openAiApiKey: string,
): Promise<{
  resolution_requirements?: Record<string, unknown>;
  personnel_requirements?: Record<string, unknown>;
  equipment_requirements?: Array<Record<string, unknown>>;
  ideal_response_sequence?: Array<Record<string, unknown>>;
  required_ppe?: Array<Record<string, unknown>>;
  estimated_resolution_minutes?: number;
}> {
  const systemPrompt = `You are an expert in emergency response requirements. Determine the EXACT personnel, equipment, and procedures needed to resolve this hazard.

${hazardContext}

You MUST fill out ALL three requirement sections. Be specific about quantities and types.

Return ONLY valid JSON:
{
  "resolution_requirements": {
    "personnel_type": "firefighter|hazmat_specialist|structural_engineer|paramedic|bomb_technician|etc.",
    "personnel_count": <number, minimum needed>,
    "equipment": ["specific_item_1", "specific_item_2", "specific_item_3"],
    "approach_method": "describe the correct approach/containment method",
    "estimated_time_minutes": <number>,
    "requires_external": <true if none of the exercise teams can handle it>,
    "external_resource": "<what external resource>" or null,
    "safety_precautions": ["precaution1", "precaution2"]
  },
  "personnel_requirements": {
    "primary_responder": "role name",
    "minimum_count": <number>,
    "specialist_needed": <true/false>,
    "specialist_type": "type" or null,
    "support_roles": ["role1", "role2"]
  },
  "equipment_requirements": [
    { "equipment_type": "internal_id", "label": "Human readable name", "quantity": <number>, "critical": <true if essential>, "applicable_teams": ["team_name_1", "team_name_2"] },
    { "equipment_type": "another_item", "label": "Display name", "quantity": <number>, "critical": <true/false>, "applicable_teams": ["team_name"] }
  ],
  "ideal_response_sequence": [
    { "step": 1, "action": "string (e.g. 'Establish exclusion zone')", "detail": "string (e.g. 'Set up 50m perimeter upwind, evacuate all civilians')", "responsible_team": "string" },
    { "step": 2, "action": "string", "detail": "string", "responsible_team": "string" }
  ],
  "required_ppe": [
    { "item": "string (e.g. 'SCBA 30-min cylinder')", "for_role": "string", "mandatory": true }
  ],
  "estimated_resolution_minutes": <number>
}

IMPORTANT:
- equipment_requirements MUST contain at least 2 items. Be specific — not just "fire_extinguisher" but the correct type (foam, CO2, dry chemical, etc.) for this hazard.
- ALWAYS include the personal protective equipment (PPE) that responders MUST wear when approaching this hazard. Examples: breathing_apparatus, hazmat_suit, fire_protective_gear, safety_vest, helmet, ppe_medical, chemical_gloves, face_shield. Mark PPE items as critical: true.
- safety_precautions should list procedural safety steps (e.g. "establish exclusion zone", "approach from upwind").
- ideal_response_sequence: the COMPLETE ordered playbook a perfect team follows from first alarm to resolution. Each step must name the responsible team. Include PPE donning, zone setup, approach, containment, mitigation, monitoring, and stand-down.
- required_ppe: list ALL PPE items that each role must wear when approaching this hazard. Be specific (e.g. "Level B HAZMAT suit" not just "PPE").
- applicable_teams: assign each equipment item ONLY to the team(s) trained to use it. Use the EXACT team names from "Teams available" above. Rules:
  - Fire-fighting gear (turnout gear, hose, foam units, fire extinguishers) → fire/hazmat team only
  - HAZMAT PPE (hazmat_suit, breathing_apparatus, chemical_gloves) → fire/hazmat team only
  - Medical equipment (defibrillator, iv_kit, burn_kit, splint, oxygen) → triage/medical team only
  - Medical PPE (ppe_medical, surgical gloves, face_shield for patient care) → triage/medical team only
  - Rescue/extrication tools (cutting_tools, hydraulic_jack, stretcher, spinal_board) → evacuation team AND triage team
  - General safety items (safety_vest, helmet) → any team that operates in the hazard zone
  - If unsure, assign to the team whose real-world role would use that equipment`;

  try {
    return await callOpenAi<{
      resolution_requirements?: Record<string, unknown>;
      personnel_requirements?: Record<string, unknown>;
      equipment_requirements?: Array<Record<string, unknown>>;
      ideal_response_sequence?: Array<Record<string, unknown>>;
      required_ppe?: Array<Record<string, unknown>>;
      estimated_resolution_minutes?: number;
    }>(
      systemPrompt,
      `What personnel, equipment, and procedures are needed to resolve this ${hazard.hazard_type} at ${venue}?`,
      openAiApiKey,
      3000,
    );
  } catch (err) {
    logger.warn({ err, hazardType: hazard.hazard_type }, 'Hazard requirements enrichment failed');
    return {};
  }
}

// Sub-call 3: Deterioration timeline
async function enrichHazardDeterioration(
  hazardContext: string,
  hazard: NonNullable<WarroomScenarioPayload['hazards']>[number],
  venue: string,
  openAiApiKey: string,
): Promise<{ deterioration_timeline?: Record<string, unknown> }> {
  const systemPrompt = `You are an expert in hazard progression and deterioration. Predict what happens if this hazard is NOT addressed over time.

${hazardContext}

Describe the realistic, cascading deterioration of this hazard at three time checkpoints. Consider venue-specific materials, structural integrity, and secondary effects.

Return ONLY valid JSON:
{
  "deterioration_timeline": {
    "at_10min": "detailed description of state after 10 minutes unaddressed — what has changed, spread, worsened",
    "at_20min": "detailed description after 20 minutes — escalation, secondary effects beginning",
    "at_30min": "detailed description after 30 minutes — critical stage, cascading failures",
    "spawns_new_hazards": <true/false>,
    "new_hazard_description": "what new hazard(s) would appear and where" or null,
    "spawns_casualties": <true/false>,
    "estimated_new_casualties": <number>,
    "new_casualty_injury_types": ["burn", "smoke_inhalation", "crush", "laceration", etc.]
  }
}`;

  try {
    return await callOpenAi<{
      deterioration_timeline?: Record<string, unknown>;
    }>(
      systemPrompt,
      `What happens if this ${hazard.hazard_type} at ${venue} is left unaddressed for 30 minutes?`,
      openAiApiKey,
      1500,
    );
  } catch (err) {
    logger.warn({ err, hazardType: hazard.hazard_type }, 'Hazard deterioration enrichment failed');
    return {};
  }
}

// ---------------------------------------------------------------------------
// Zone polygon computation — snap radii to building footprints
// ---------------------------------------------------------------------------

interface ZoneWithPolygon {
  zone_type: string;
  radius_m: number;
  polygon: [number, number][];
  ppe_required: string[];
  allowed_teams: string[];
  activities: string[];
}

/**
 * Convert radius-based zones into polygon-based zones.
 * Hot zone: building footprint if available, else circle polygon.
 * Warm zone: scaled building footprint, else circle polygon.
 * Cold zone: always circle polygon.
 */
function computeZonePolygons(
  hazardLat: number,
  hazardLng: number,
  zones: Array<{
    zone_type: string;
    radius_m: number;
    ppe_required: string[];
    allowed_teams: string[];
    activities: string[];
  }>,
  osmBuildings?: OsmBuilding[],
): ZoneWithPolygon[] {
  let bestFootprint: [number, number][] | undefined;

  if (osmBuildings?.length) {
    for (const b of osmBuildings) {
      if (!b.footprint_polygon || b.footprint_polygon.length < 3) continue;
      if (pointInPolygon(hazardLat, hazardLng, b.footprint_polygon)) {
        bestFootprint = b.footprint_polygon;
        break;
      }
    }
    if (!bestFootprint) {
      let minDist = Infinity;
      for (const b of osmBuildings) {
        if (!b.footprint_polygon || b.footprint_polygon.length < 3) continue;
        const d = geoHaversineM(hazardLat, hazardLng, b.lat, b.lng);
        if (d < minDist) {
          minDist = d;
          bestFootprint = b.footprint_polygon;
        }
      }
      const hotZone = zones.find((z) => z.zone_type === 'hot');
      if (bestFootprint && minDist > (hotZone?.radius_m ?? 50) * 0.5) {
        bestFootprint = undefined;
      }
    }
  }

  const sorted = [...zones].sort((a, b) => a.radius_m - b.radius_m);
  const hotRadius =
    sorted.find((z) => z.zone_type === 'hot')?.radius_m ?? sorted[0]?.radius_m ?? 50;

  return sorted.map((z) => {
    let polygon: [number, number][];

    if (z.zone_type === 'hot' && bestFootprint) {
      polygon = [...bestFootprint];
      if (
        polygon.length > 1 &&
        (polygon[0][0] !== polygon[polygon.length - 1][0] ||
          polygon[0][1] !== polygon[polygon.length - 1][1])
      ) {
        polygon.push(polygon[0]);
      }
    } else if (z.zone_type === 'warm' && bestFootprint) {
      const [cLat, cLng] = polygonCentroid(bestFootprint);
      const scale = z.radius_m / Math.max(hotRadius, 1);
      polygon = scalePolygonFromCentroid(bestFootprint, cLat, cLng, scale);
      if (
        polygon.length > 1 &&
        (polygon[0][0] !== polygon[polygon.length - 1][0] ||
          polygon[0][1] !== polygon[polygon.length - 1][1])
      ) {
        polygon.push(polygon[0]);
      }
    } else {
      polygon = circleToPolygon(hazardLat, hazardLng, z.radius_m);
    }

    return {
      zone_type: z.zone_type,
      radius_m: z.radius_m,
      polygon,
      ppe_required: z.ppe_required,
      allowed_teams: z.allowed_teams,
      activities: z.activities,
    };
  });
}

// ---------------------------------------------------------------------------
// Unified Incident Zones — ONE set of hot/warm/cold for the entire incident
// ---------------------------------------------------------------------------

async function generateUnifiedIncidentZones(
  input: WarroomGenerateInput,
  hazards: NonNullable<WarroomScenarioPayload['hazards']>,
  openAiApiKey: string,
  teamNames: string[],
  onProgress?: WarroomAiProgressCallback,
): Promise<ZoneWithPolygon[]> {
  onProgress?.('Generating unified incident zones (hot/warm/cold)...');

  const { scenario_type, setting, venue_name, location } = input;
  const venue = venue_name || location || setting;

  const hazardSummary = hazards
    .map(
      (h) =>
        `- ${h.hazard_type} (${(h.properties as Record<string, unknown>).size || 'medium'}) at (${h.location_lat}, ${h.location_lng}): ${(h.properties as Record<string, unknown>).fuel_source || h.hazard_type}`,
    )
    .join('\n');

  const incidentLat = hazards.reduce((s, h) => s + Number(h.location_lat), 0) / hazards.length;
  const incidentLng = hazards.reduce((s, h) => s + Number(h.location_lng), 0) / hazards.length;

  const worstSize = hazards.some((h) => (h.properties as Record<string, unknown>).size === 'large')
    ? 'large'
    : hazards.some((h) => (h.properties as Record<string, unknown>).size === 'medium')
      ? 'medium'
      : 'small';

  const systemPrompt = `You are an ICS/NIMS Incident Safety Officer. Define ONE unified set of Hot, Warm, and Cold zone boundaries for this ENTIRE incident — not per-hazard.

Scenario: ${scenario_type} at ${venue}
Teams available: ${teamNames.join(', ')}

ALL active hazards at this incident:
${hazardSummary}

Incident centroid: (${incidentLat.toFixed(5)}, ${incidentLng.toFixed(5)})
Worst-case hazard size: ${worstSize}
Number of hazards: ${hazards.length}

The zones must ENVELOPE all hazards. The hot zone must contain ALL hazard locations plus a safety buffer. Consider the combined threat footprint — multiple overlapping hazards create a larger danger area than any single hazard.

Radius guidelines (adjust UP for multiple hazards):
- Single small hazard: hot ~30-50m, warm ~80-120m, cold ~200-350m
- Single large hazard: hot ~80-120m, warm ~180-280m, cold ~400-600m
- Multiple clustered hazards: hot ~100-200m, warm ~250-400m, cold ~500-800m
- CBRNE or major explosion: hot ~150-300m, warm ~400-600m, cold ~800-1200m

Adjust for hazard mix:
- Chemical/HAZMAT present: expand warm zone for decontamination corridor
- Fire + gas leak: expand hot zone for explosive risk
- Structural collapse: consider aftershock/secondary collapse in warm zone

Return ONLY valid JSON:
{
  "zones": [
    {
      "zone_type": "hot",
      "radius_m": <number>,
      "ppe_required": ["equipment_ids"],
      "allowed_teams": ["team_names"],
      "activities": ["rapid_extrication", "suppression", "containment", "reconnaissance"],
      "pin_guidance": "What belongs here: trapped casualties, active hazards, structural damage. Only specialized rescue teams (fire/hazmat) with full PPE. NO prolonged treatment — extract and move to warm zone."
    },
    {
      "zone_type": "warm",
      "radius_m": <number>,
      "ppe_required": ["equipment_ids"],
      "allowed_teams": ["team_names"],
      "activities": ["triage", "decontamination", "stabilization", "handoff"],
      "pin_guidance": "What belongs here: triage points, decontamination stations, casualty collection points. Extracted casualties move here for initial assessment. Medical/triage teams operate here with respiratory protection."
    },
    {
      "zone_type": "cold",
      "radius_m": <number>,
      "ppe_required": [],
      "allowed_teams": ["all"],
      "activities": ["treatment", "staging", "command", "transport", "definitive_care"],
      "pin_guidance": "What belongs here: command post, staging areas, treatment areas, ambulance loading, assembly points for evacuees. Walking wounded and evacuee crowds congregate here. Media staging. Convergent crowds (onlookers, family) gather at the outer edge."
    }
  ]
}

RULES:
- ppe_required: use equipment IDs like scba, hazmat_suit, fire_protective_gear, respirator, safety_vest, helmet, ppe_medical, chemical_gloves, face_shield, turnout_gear
- allowed_teams: use EXACT team names from above. Hot zone = only fire/hazmat specialists. Warm zone = add triage/medical. Cold zone = "all".
- Each zone radius MUST be larger than the previous (hot < warm < cold)
- The hot zone MUST be large enough to contain ALL hazard locations`;

  try {
    const result = await callOpenAi<{
      zones?: Array<{
        zone_type: string;
        radius_m: number;
        ppe_required: string[];
        allowed_teams: string[];
        activities: string[];
        pin_guidance?: string;
      }>;
    }>(
      systemPrompt,
      `Define the unified hot, warm, and cold zones for this ${scenario_type} incident with ${hazards.length} active hazards.`,
      openAiApiKey,
      2000,
    );

    const rawZones = result.zones ?? [];
    if (rawZones.length === 0) {
      logger.warn('Unified zone generation returned empty; using defaults');
      return [];
    }

    return computeZonePolygons(incidentLat, incidentLng, rawZones, input.osmBuildings);
  } catch (err) {
    logger.warn({ err }, 'Unified incident zone generation failed');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Phase 4b2c — Casualty Generation (two-phase: profiles then placement)
// ---------------------------------------------------------------------------

interface VictimProfile {
  id: number;
  injuries: Array<{ type: string; severity: string; body_part: string; visible_signs: string }>;
  triage_color: string;
  mobility: string;
  consciousness: string;
  breathing: string;
  visible_description: string;
  treatment_requirements: Array<{ intervention: string; priority: string; reason: string }>;
  transport_prerequisites: string[];
  contraindications: string[];
  ideal_response_sequence: Array<{ step: number; action: string; detail: string }>;
  required_ppe: string[];
  required_equipment: Array<{ item: string; quantity: number; purpose: string }>;
  expected_time_to_treat_minutes: number;
  appears_at_minutes: number;
}

async function generateCasualties(
  input: WarroomGenerateInput,
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
  locations?: WarroomScenarioPayload['locations'],
  hazards?: WarroomScenarioPayload['hazards'],
  zoneSummaryBlock?: string,
): Promise<WarroomScenarioPayload['casualties']> {
  const include = input.complexity_tier === 'full' || input.complexity_tier === 'rich';
  if (!include) return undefined;

  const { scenario_type, setting, venue_name, location, researchContext } = input;
  const venue = venue_name || location || setting;

  const similarCasesBlock =
    researchContext?.similar_cases && researchContext.similar_cases.length > 0
      ? `\nSIMILAR REAL INCIDENTS (calibrate injury types and severity against these):\n${similarCasesToPromptBlock(researchContext.similar_cases)}`
      : '';

  const threatProfile = input.threat_profile;
  const casualtyRules = threatProfile ? getThreatHazardRules(threatProfile.weapon_class) : null;
  const advCount = threatProfile?.adversary_count ?? 1;
  const advScale = Math.min(advCount, 4);
  const baseCasRange: [number, number] = [
    Math.round((casualtyRules?.casualty_range[0] ?? 15) * advScale),
    Math.round((casualtyRules?.casualty_range[1] ?? 20) * advScale),
  ];
  const weaponAssessment = await assessWeaponLethality(
    threatProfile?.weapon_type ?? '',
    threatProfile?.weapon_class ?? '',
    advCount,
    baseCasRange,
    openAiApiKey,
    researchContext?.similar_cases,
  );
  const MAX_VICTIM_PINS = 50;
  const minCasualties = Math.min(weaponAssessment.minCasualties, MAX_VICTIM_PINS);
  const maxCasualties = Math.min(weaponAssessment.maxCasualties, MAX_VICTIM_PINS);
  logger.info(
    {
      baseCasRange,
      assessedMin: weaponAssessment.minCasualties,
      assessedMax: weaponAssessment.maxCasualties,
      finalMin: minCasualties,
      finalMax: maxCasualties,
    },
    'Casualty range resolved',
  );
  const injuryEmphasis = casualtyRules?.injury_emphasis ?? [
    'burn',
    'laceration',
    'fracture',
    'blast_injury',
    'crush_injury',
    'smoke_inhalation',
    'concussion',
    'shrapnel_wound',
    'psychological',
    'hemorrhage',
  ];
  const isMelee = threatProfile?.weapon_class?.startsWith('melee_');
  const isExplosive = threatProfile?.weapon_class === 'explosive';
  const weaponDesc = threatProfile?.weapon_type || scenario_type;

  // --- PHASE 1: Generate victim profiles (no location data) ---
  onProgress?.('Creating victim profiles...');
  const profiles = await generateVictimProfiles(
    scenario_type,
    venue,
    weaponDesc,
    injuryEmphasis,
    minCasualties,
    maxCasualties,
    isMelee,
    isExplosive,
    threatProfile,
    similarCasesBlock,
    narrative,
    openAiApiKey,
  );
  if (!profiles?.length) return undefined;

  // --- PHASE 2: Place victims on the map ---
  onProgress?.(`Placing ${profiles.length} casualties on map...`);
  const placed = await placeVictimsOnMap(
    profiles,
    scenario_type,
    venue,
    setting,
    isMelee,
    isExplosive,
    weaponDesc,
    threatProfile,
    locations,
    hazards,
    zoneSummaryBlock,
    narrative,
    openAiApiKey,
  );
  return placed?.length ? placed : undefined;
}

/**
 * Phase 1: Generate medically accurate victim profiles without any spatial data.
 * The AI focuses purely on creating the right number of victims with realistic
 * injury distributions for the weapon type.
 */
async function generateVictimProfiles(
  scenarioType: string,
  venue: string,
  weaponDesc: string,
  injuryEmphasis: string[],
  minCasualties: number,
  maxCasualties: number,
  isMelee: boolean | undefined,
  isExplosive: boolean | undefined,
  threatProfile: ThreatProfile | undefined,
  similarCasesBlock: string,
  narrative: { title?: string; description?: string; briefing?: string } | undefined,
  openAiApiKey: string,
): Promise<VictimProfile[] | null> {
  const triageGuidance = isMelee
    ? `Triage distribution for a melee ${weaponDesc} attack with ${threatProfile?.adversary_count ?? 1} attacker(s):
- ~5% black (deceased — fatal stab/slash wounds)
- ~15% red (severe weapon injuries — deep lacerations, arterial bleeds, organ damage)
- ~30% yellow (moderate — significant cuts, fractures from falls, non-life-threatening)
- ~50% green (minor injuries, bruises from stampede/falls, psychological trauma)
Do NOT generate trapped casualties or casualties behind fire/debris — a ${weaponDesc} cannot cause environmental hazards.`
    : isExplosive
      ? `Triage distribution for a major explosion:
- ~8% black (deceased)
- ~18% red (immediate/critical — blast injuries, burns, crush injuries)
- ~30% yellow (delayed/serious — shrapnel, moderate burns, fractures)
- ~44% green (walking wounded, minor lacerations, psychological)
Include some trapped casualties and casualties behind environmental barriers.`
      : `Triage distribution appropriate for a ${scenarioType}. Generate a realistic mix of severity levels.`;

  const systemPrompt = `You are a pre-hospital emergency medicine expert creating victim profiles for a crisis training exercise.

Scenario: ${scenarioType} at ${venue}
${narrative ? `Narrative: ${narrative.title} — ${narrative.description}` : ''}
Weapon: ${weaponDesc} (${threatProfile?.weapon_class || 'unknown'})
Attackers: ${threatProfile?.adversary_count ?? 1}
${similarCasesBlock}

You MUST generate EXACTLY ${minCasualties} to ${maxCasualties} individual victim profiles. Each victim is ONE person.

${triageGuidance}

INJURY TYPES — only use injuries a ${weaponDesc} can realistically cause: ${injuryEmphasis.join(', ')}

For EACH victim, provide:
- injuries: array of specific injuries with type, severity (minor|moderate|severe|critical), body_part, and visible_signs (what a responder physically observes)
- triage_color: green|yellow|red|black
- mobility: ambulatory|non_ambulatory|trapped
- consciousness: alert|confused|unconscious|unresponsive
- breathing: normal|labored|absent
- visible_description: 1-2 sentences of ONLY what a responder SEES approaching this person — do NOT reveal diagnoses or treatment
- treatment_requirements: real pre-hospital interventions with priority and clinical rationale
- transport_prerequisites: what MUST be stabilized before safe transport
- contraindications: dangerous actions for this specific patient
- ideal_response_sequence: ORDERED step-by-step sequence of what a perfect responder does from approach to handoff (e.g. step 1: Don PPE, step 2: Primary survey DRABC, step 3: Apply tourniquet, etc.)
- required_ppe: list of specific PPE items responders MUST wear to safely treat this patient (e.g. "nitrile gloves", "N95 respirator", "face shield", "full turnout gear")
- required_equipment: list of specific equipment items with quantity and purpose needed to treat this patient (e.g. { "item": "SAM splint", "quantity": 2, "purpose": "immobilize fractured left tibia" })
- expected_time_to_treat_minutes: realistic estimate of time (in minutes) for pre-hospital treatment before transport-ready
- appears_at_minutes: 0 for immediately visible, 5-20 for delayed discovery

Return ONLY valid JSON:
{
  "victims": [
    {
      "id": 1,
      "injuries": [{ "type": "string", "severity": "minor|moderate|severe|critical", "body_part": "string", "visible_signs": "string" }],
      "triage_color": "green|yellow|red|black",
      "mobility": "ambulatory|non_ambulatory|trapped",
      "consciousness": "alert|confused|unconscious|unresponsive",
      "breathing": "normal|labored|absent",
      "visible_description": "string",
      "treatment_requirements": [{ "intervention": "string", "priority": "critical|high|medium", "reason": "string" }],
      "transport_prerequisites": ["string"],
      "contraindications": ["string"],
      "ideal_response_sequence": [{ "step": 1, "action": "string", "detail": "string" }],
      "required_ppe": ["string"],
      "required_equipment": [{ "item": "string", "quantity": 1, "purpose": "string" }],
      "expected_time_to_treat_minutes": 10,
      "appears_at_minutes": 0
    }
  ]
}

CRITICAL: You MUST return ${minCasualties}-${maxCasualties} victims. Do NOT return fewer.`;

  const BATCH_SIZE = 5;
  const totalTarget = Math.round((minCasualties + maxCasualties) / 2);
  const batchCount = Math.ceil(totalTarget / BATCH_SIZE);
  const allProfiles: VictimProfile[] = [];

  const batchPromises: Array<Promise<VictimProfile[] | null>> = [];
  for (let b = 0; b < batchCount; b++) {
    const batchMin = Math.min(BATCH_SIZE, totalTarget - b * BATCH_SIZE);
    const batchMax = batchMin;
    const startId = b * BATCH_SIZE + 1;
    const batchTriageHint =
      b === 0
        ? `This is batch ${b + 1}/${batchCount}. Focus on the most severely injured (red/black triage).`
        : b === batchCount - 1
          ? `This is batch ${b + 1}/${batchCount}. Focus on walking wounded and psychological cases (green triage).`
          : `This is batch ${b + 1}/${batchCount}. Focus on moderately injured (yellow triage) with some variety.`;

    const batchSystemPrompt =
      systemPrompt.replace(
        /You MUST generate EXACTLY \d+ to \d+ individual victim profiles/,
        `You MUST generate EXACTLY ${batchMin} to ${batchMax} individual victim profiles`,
      ) + `\n\nStart victim IDs at ${startId}. ${batchTriageHint}`;
    const batchUserPrompt = `Generate ${batchMin}-${batchMax} victim profiles (IDs starting at ${startId}) for a ${scenarioType} involving ${weaponDesc} with ${threatProfile?.adversary_count ?? 1} attacker(s) at ${venue}.`;

    batchPromises.push(
      (async () => {
        try {
          const parsed = await callOpenAi<{ victims?: VictimProfile[] }>(
            batchSystemPrompt,
            batchUserPrompt,
            openAiApiKey,
            4000,
          );
          return parsed.victims?.length ? parsed.victims : null;
        } catch (err) {
          logger.warn({ err, batch: b + 1 }, 'Victim profile batch failed');
          return null;
        }
      })(),
    );
  }

  const batchResults = await Promise.all(batchPromises);
  for (const result of batchResults) {
    if (result) allProfiles.push(...result);
  }

  // Re-number IDs sequentially
  allProfiles.forEach((p, i) => {
    p.id = i + 1;
  });

  logger.info(
    {
      batches: batchCount,
      totalGenerated: allProfiles.length,
      targetRange: `${minCasualties}-${maxCasualties}`,
    },
    'Victim profile batch generation complete',
  );

  return allProfiles.length > 0 ? allProfiles : null;
}

/**
 * Phase 2: Take pre-generated victim profiles and assign map coordinates,
 * floor levels, and accessibility based on venue layout, incident sites,
 * hazard positions, and zone geometry.
 */
async function placeVictimsOnMap(
  profiles: VictimProfile[],
  scenarioType: string,
  venue: string,
  setting: string,
  isMelee: boolean | undefined,
  isExplosive: boolean | undefined,
  weaponDesc: string,
  threatProfile: ThreatProfile | undefined,
  locations?: WarroomScenarioPayload['locations'],
  hazards?: WarroomScenarioPayload['hazards'],
  zoneSummaryBlock?: string,
  narrative?: { title?: string; description?: string; briefing?: string },
  openAiApiKey?: string,
): Promise<WarroomScenarioPayload['casualties']> {
  if (!openAiApiKey) return undefined;

  const incidentSites =
    locations?.filter(
      (l) =>
        l.pin_category === 'incident_site' ||
        l.location_type?.toLowerCase().includes('blast') ||
        l.location_type?.toLowerCase().includes('epicentre'),
    ) ?? [];

  const hazardBlock = hazards?.length
    ? `\nActive hazards:\n${hazards.map((h) => `- ${h.hazard_type} at (${h.location_lat}, ${h.location_lng}): ${h.enriched_description?.slice(0, 150) || (h.properties as Record<string, unknown>).fuel_source || h.hazard_type}`).join('\n')}`
    : '';

  const exitPins = locations?.filter((l) => l.pin_category === 'entry_exit') ?? [];
  const exitBlock =
    exitPins.length > 0
      ? `\nEntry/exit points:\n${exitPins.map((e) => `- ${e.label} at (${e.coordinates.lat}, ${e.coordinates.lng})`).join('\n')}`
      : '';

  const profileSummary = profiles
    .map(
      (p) =>
        `Victim #${p.id}: triage=${p.triage_color}, mobility=${p.mobility}, injuries=[${p.injuries.map((i) => `${i.severity} ${i.type} to ${i.body_part}`).join('; ')}], appears_at=${p.appears_at_minutes}min`,
    )
    .join('\n');

  const placementGuidance = isMelee
    ? `MELEE ATTACK PLACEMENT LOGIC:
- RED/BLACK triage victims (severe weapon injuries): Place within 10-30m of the incident site — these are the people the attacker directly struck. They couldn't move far.
- YELLOW victims (moderate injuries): Place 20-60m from incident — knocked over, cut by secondary contact, fell while fleeing. Some crawled or stumbled away.
- GREEN victims (minor/psychological): Place 50-150m+ from incident — escaped but with minor injuries from stampede, falls, or psychological shock. Found near exits, corridors, stairwells.
- Accessibility should be "open" for all or nearly all — a ${weaponDesc} does not create environmental barriers.
- Spread victims across realistic paths of flight from the incident site toward exits.`
    : isExplosive
      ? `EXPLOSION PLACEMENT LOGIC:
- BLACK/RED victims: Place within the blast radius near the incident site. Some may be trapped under debris or behind fire.
- YELLOW victims: Place in the warm/transition zone around the blast area. Shrapnel and blast wave injuries.
- GREEN victims: Place further out — near exits, in corridors, outside the building.
- Include accessibility values: "behind_fire", "under_debris", "in_smoke" for victims near the blast center.
- Delayed-discovery victims should be in areas obscured by smoke or debris.`
      : `PLACEMENT LOGIC:
- Most severely injured victims closest to the incident site.
- Moderately injured further away.
- Walking wounded and psychological cases near exits and perimeter.
- Match accessibility to the realistic environmental conditions caused by a ${weaponDesc}.`;

  const systemPrompt = `You are a crisis exercise spatial planner. You have ${profiles.length} pre-generated victim profiles. Your job is to assign each victim a realistic map location.

Scenario: ${scenarioType} at ${venue}
Setting: ${setting}
${narrative ? `Narrative: ${narrative.title} — ${narrative.description}` : ''}
${incidentSites.length > 0 ? `Incident site: ${incidentSites[0].label} at (${incidentSites[0].coordinates.lat}, ${incidentSites[0].coordinates.lng})` : ''}
${exitBlock}
${hazardBlock}
${zoneSummaryBlock || ''}

${placementGuidance}

VICTIM PROFILES TO PLACE:
${profileSummary}

For EACH victim, assign:
- location_lat, location_lng: realistic coordinates near the venue, based on their triage severity and the placement logic above
- floor_level: "G" for ground, "B1"/"B2" for basement, "1"/"2" for upper floors
- accessibility: "open" | "behind_fire" | "under_debris" | "in_smoke" | "blocked_corridor"

Return ONLY valid JSON:
{
  "placements": [
    { "id": 1, "location_lat": number, "location_lng": number, "floor_level": "G", "accessibility": "open" }
  ]
}

RULES:
- Return EXACTLY ${profiles.length} placements, one per victim ID.
- Coordinates must be within realistic distance of the venue/incident site.
- Do NOT change victim count — place ALL ${profiles.length} victims.`;

  type Placement = {
    id: number;
    location_lat: number;
    location_lng: number;
    floor_level: string;
    accessibility: string;
  };

  const PLACEMENT_BATCH = 15;
  const placementMap = new Map<number, Placement>();

  const placementBatches: VictimProfile[][] = [];
  for (let i = 0; i < profiles.length; i += PLACEMENT_BATCH) {
    placementBatches.push(profiles.slice(i, i + PLACEMENT_BATCH));
  }

  const placementPromises = placementBatches.map(async (batch) => {
    const batchSummary = batch
      .map(
        (p) =>
          `Victim #${p.id}: triage=${p.triage_color}, mobility=${p.mobility}, injuries=[${p.injuries.map((i) => `${i.severity} ${i.type} to ${i.body_part}`).join('; ')}], appears_at=${p.appears_at_minutes}min`,
      )
      .join('\n');

    const batchPrompt = systemPrompt
      .replace(profileSummary, batchSummary)
      .replace(/Return EXACTLY \d+ placements/, `Return EXACTLY ${batch.length} placements`)
      .replace(/place ALL \d+ victims/, `place ALL ${batch.length} victims`);
    const batchUserPrompt = `Place ${batch.length} victims (IDs: ${batch.map((p) => p.id).join(', ')}) on the map for "${narrative?.title || scenarioType}" at ${venue}.`;

    try {
      const parsed = await callOpenAi<{ placements?: Placement[] }>(
        batchPrompt,
        batchUserPrompt,
        openAiApiKey,
        Math.max(2000, batch.length * 80),
      );
      return parsed.placements ?? [];
    } catch (err) {
      logger.warn({ err, batchSize: batch.length }, 'Victim placement batch failed');
      return [];
    }
  });

  const placementResults = await Promise.all(placementPromises);
  for (const batch of placementResults) {
    for (const p of batch) placementMap.set(p.id, p);
  }

  // Merge profiles with placements (fall back to incident site for unplaced victims)
  return profiles.map((profile) => {
    const placement = placementMap.get(profile.id);
    return {
      casualty_type: 'patient' as const,
      location_lat: placement?.location_lat ?? incidentSites[0]?.coordinates.lat ?? 0,
      location_lng: placement?.location_lng ?? incidentSites[0]?.coordinates.lng ?? 0,
      floor_level: placement?.floor_level ?? 'G',
      headcount: 1,
      conditions: {
        injuries: profile.injuries,
        triage_color: profile.triage_color,
        mobility: profile.mobility,
        accessibility: placement?.accessibility ?? 'open',
        consciousness: profile.consciousness,
        breathing: profile.breathing,
        visible_description: profile.visible_description,
        treatment_requirements: profile.treatment_requirements,
        transport_prerequisites: profile.transport_prerequisites,
        contraindications: profile.contraindications,
        ideal_response_sequence: profile.ideal_response_sequence,
        required_ppe: profile.required_ppe,
        required_equipment: profile.required_equipment,
        expected_time_to_treat_minutes: profile.expected_time_to_treat_minutes,
      },
      status: 'undiscovered' as const,
      appears_at_minutes: profile.appears_at_minutes ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Phase 4b2d — Crowd / Evacuee Group Generation
// ---------------------------------------------------------------------------

async function generateCrowdPins(
  input: WarroomGenerateInput,
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
  locations?: WarroomScenarioPayload['locations'],
  zoneSummaryBlock?: string,
): Promise<WarroomScenarioPayload['casualties']> {
  const include = input.complexity_tier === 'full' || input.complexity_tier === 'rich';
  if (!include) return undefined;

  onProgress?.('Generating crowd/evacuee pins...');

  const { scenario_type, setting, venue_name, location, researchContext } = input;
  const venue = venue_name || location || setting;

  const similarCasesBlock =
    researchContext?.similar_cases && researchContext.similar_cases.length > 0
      ? `\nSIMILAR REAL INCIDENTS (for crowd behavior reference):\n${similarCasesToPromptBlock(researchContext.similar_cases)}`
      : '';

  const exitPins =
    locations?.filter((l) => l.pin_category === 'entry_exit' || l.pin_category === 'access') ?? [];

  const exitBlock =
    exitPins.length > 0
      ? `\nEntry/exit points:\n${exitPins.map((e) => `- ${e.label} at (${e.coordinates.lat}, ${e.coordinates.lng})`).join('\n')}`
      : '';

  const threatProfile = input.threat_profile;
  const crowdRules = threatProfile ? getThreatHazardRules(threatProfile.weapon_class) : null;
  const crowdDesc = crowdRules?.crowd_description || 'Civilians are evacuating in panic.';
  const panicRadius = threatProfile?.expected_damage.crowd_panic_radius || 'wide';
  const isMeleeAttack = threatProfile?.weapon_class?.startsWith('melee_');

  const systemPrompt = `You are an expert in crowd dynamics and evacuation planning generating civilian crowd pins for a training exercise.

Scenario type: ${scenario_type}
Venue: ${venue}
Setting: ${setting}
${narrative ? `Narrative: ${narrative.title} — ${narrative.description}` : ''}
${exitBlock}
${zoneSummaryBlock || ''}
${await buildThreatProfileBlock(threatProfile, openAiApiKey, researchContext?.similar_cases)}${similarCasesBlock}

CROWD BEHAVIOR for this threat type: ${crowdDesc}
Panic radius: ${panicRadius} — ${panicRadius === 'immediate' ? 'only people very close (<50m) are aware and reacting' : panicRadius === 'local' ? 'people within ~200m are reacting, further away may be unaware' : 'entire venue is affected, mass evacuation'}

Generate ${isMeleeAttack ? '4-8' : '8-15'} crowd/evacuee group pins. Each represents a GROUP of civilians at a specific location.

${
  isMeleeAttack
    ? `MELEE ATTACK CROWD DYNAMICS:
- NEAR ATTACK (within 30m): Small groups (3-10) who witnessed the attack and are running away. Terrified, screaming.
- NEARBY (30-100m): Groups (10-30) who heard commotion but may not know what happened. Confused, some moving toward exits, some frozen.
- FURTHER OUT (>100m): Groups may be completely unaware of the incident. Normal behavior, possibly curious about commotion.
- People beyond the immediate attack area do NOT need to be in panic — a ${threatProfile?.weapon_type} creates localized fear, not venue-wide stampede.`
    : `ZONE-BASED PLACEMENT — place crowds where they would realistically be:
- WARM ZONE: Small groups (5-15) of dazed people who staggered out of the danger area. Confused, some injured.
- COLD ZONE (near exits): Large groups (30-80) bottlenecking at exits. Panicking, some crushing.
- COLD ZONE (assembly areas): Groups (20-60) who made it outside. Anxious but calmer.
- OUTSIDE PERIMETER: Groups of bystanders, curious onlookers, people filming.`
}

Return ONLY valid JSON:
{
  "crowds": [
    {
      "casualty_type": "crowd",
      "location_lat": number,
      "location_lng": number,
      "floor_level": "G",
      "headcount": number (${isMeleeAttack ? '3-30' : '5-80'} per group),
      "conditions": {
        "behavior": "calm|anxious|panicking|sheltering|fleeing",
        "movement_direction": "string|null (e.g. 'toward south exit', 'stationary', 'milling')",
        "mixed_wounded": [{ "injury_type": "string", "severity": "minor|moderate", "count": number }],
        "bottleneck": true/false,
        "blocking_exit": "string|null (label of exit being blocked, if any)",
        "visible_description": "1-2 sentence description of what a marshal approaching sees",
        "ideal_response_sequence": [{ "step": 1, "action": "string", "detail": "string" }],
        "required_equipment": [{ "item": "string", "quantity": 1, "purpose": "string" }],
        "required_personnel": { "role": "string", "count": number },
        "management_priority": "low|medium|high|critical"
      },
      "status": "identified",
      "appears_at_minutes": 0
    }
  ]
}

CROWD RESPONSE REQUIREMENTS:
- ideal_response_sequence: Step-by-step perfect response for managing this crowd. E.g.: step 1: Assess crowd size and mood, step 2: Deploy marshals at bottleneck, step 3: Open alternative exit, step 4: Use PA to redirect, step 5: Monitor for crush risk.
- required_equipment: what is needed (megaphone, barriers, first aid kit for mixed_wounded, etc.)
- required_personnel: who handles this crowd (marshal, police officer, etc.) and how many
- management_priority: how urgently this crowd needs attention (critical if bottleneck or stampede risk)

RULES:
- Total civilian count across all groups should be ${isMeleeAttack ? '50-150' : '200-500'} (proportional to venue size and panic radius)
${isMeleeAttack ? '- Most groups should be calm or anxious — only groups within 30m of the attack should be panicking or fleeing' : '- At least 2-3 groups should be creating bottlenecks near exits'}
- Some groups appear later as people emerge from different parts of the venue
- Vary group sizes based on proximity to the incident`;

  const crowdZones = isMeleeAttack
    ? [
        {
          label: 'near-attack and nearby crowds (within 100m)',
          count: '2-4',
          focus: 'Groups closest to the attack — terrified, screaming, some frozen.',
        },
        {
          label: 'further-out and perimeter crowds (beyond 100m)',
          count: '2-4',
          focus: 'Groups further away — confused bystanders, onlookers, people near exits.',
        },
      ]
    : [
        {
          label: 'warm-zone and exit crowds',
          count: '4-7',
          focus: 'Groups staggering out of danger area and bottlenecking at exits.',
        },
        {
          label: 'assembly area and perimeter crowds',
          count: '4-8',
          focus: 'Groups outside — calmer evacuees, bystanders, onlookers filming.',
        },
      ];

  const batchPromises = crowdZones.map(async (zone) => {
    const batchPrompt =
      systemPrompt.replace(
        /Generate \d+-\d+ crowd\/evacuee group pins/,
        `Generate ${zone.count} crowd/evacuee group pins`,
      ) + `\n\nFOCUS ON: ${zone.label}. ${zone.focus}`;
    const batchUserPrompt = `Generate ${zone.count} ${zone.label} for "${narrative?.title || scenario_type}" at ${venue}.`;

    try {
      const parsed = await callOpenAi<{ crowds?: WarroomScenarioPayload['casualties'] }>(
        batchPrompt,
        batchUserPrompt,
        openAiApiKey,
        4000,
      );
      return parsed.crowds ?? [];
    } catch (err) {
      logger.warn({ err, zone: zone.label }, 'Crowd pin batch failed');
      return [];
    }
  });

  const results = await Promise.all(batchPromises);
  const allCrowds = results.flat();
  logger.info(
    { batches: crowdZones.length, totalCrowds: allCrowds.length },
    'Crowd pin batch generation complete',
  );
  return allCrowds.length > 0 ? allCrowds : undefined;
}

// ---------------------------------------------------------------------------
// Phase 4b2e — Convergent Crowd Generation (onlookers, media, family arriving later)
// ---------------------------------------------------------------------------

interface ConvergentCrowdResult {
  crowds?: WarroomScenarioPayload['casualties'];
  alertInjects?: WarroomScenarioPayload['time_injects'];
}

async function generateConvergentCrowds(
  input: WarroomGenerateInput,
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
  locations?: WarroomScenarioPayload['locations'],
  teamNames?: string[],
): Promise<ConvergentCrowdResult> {
  const include = input.complexity_tier === 'full' || input.complexity_tier === 'rich';
  if (!include) return {};

  onProgress?.('Generating convergent crowd pins (onlookers, media, family)...');

  const { scenario_type, setting, venue_name, location, researchContext } = input;
  const venue = venue_name || location || setting;
  const durationMinutes = input.duration_minutes ?? 60;

  const entryExitPins =
    locations?.filter((l) => l.pin_category === 'entry_exit' || l.pin_category === 'access') ?? [];

  const entryBlock =
    entryExitPins.length > 0
      ? `\nEntry/exit points (convergent crowds arrive at these):\n${entryExitPins.map((e) => `- ${e.label} at (${e.coordinates.lat}, ${e.coordinates.lng})`).join('\n')}`
      : '';

  const incidentPin = locations?.find((l) => l.pin_category === 'incident_site');
  const incidentBlock = incidentPin
    ? `\nIncident site: (${incidentPin.coordinates.lat}, ${incidentPin.coordinates.lng})`
    : '';

  const crowdDynamics = researchContext?.crowd_dynamics;
  const researchBlock = crowdDynamics
    ? `\nRESEARCH ON CROWD DYNAMICS FOR THIS SCENARIO TYPE:\n${crowdDynamicsToPromptBlock(crowdDynamics)}`
    : '';

  const teamsBlock = teamNames?.length ? `\nAvailable teams: ${teamNames.join(', ')}` : '';

  const convergentThreat = input.threat_profile;
  const isMeleeConvergent = convergentThreat?.weapon_class?.startsWith('melee_');

  const systemPrompt = `You are an expert in crowd dynamics and post-incident convergent behavior, generating convergent crowd pins for a crisis training exercise.

Scenario type: ${scenario_type}
Venue: ${venue}
Setting: ${setting}
Game duration: ${durationMinutes} minutes
${narrative ? `Narrative: ${narrative.title} — ${narrative.description}` : ''}
${entryBlock}
${incidentBlock}
${researchBlock}
${teamsBlock}
${await buildThreatProfileBlock(convergentThreat, openAiApiKey, researchContext?.similar_cases)}

${isMeleeConvergent ? `NOTE: This is a localized melee attack. Convergent crowds will be SMALLER and arrive LATER than for mass-casualty events. Media may arrive but in smaller numbers. Family arrivals are fewer. Generate 2-4 groups.` : ''}

CONVERGENT CROWDS are people who arrive FROM OUTSIDE the incident after word spreads. They are NOT evacuees. They move TOWARD the incident scene. Types include:
- onlooker: Curious bystanders gathering near the perimeter to watch. They obstruct access and crowd exits.
- media: News crews and citizen journalists pushing for access to film. They may breach cordons.
- family: Distraught family members searching for loved ones, may be hysterical or aggressive toward responders.
- helper: Self-appointed volunteers who may cause harm by interfering with trained responders.

Generate 4-8 convergent crowd groups that arrive at different entry points at staggered times.
For EACH crowd group, also generate a paired ALERT INJECT that fires at the same time the crowd appears. The alert inject notifies the relevant team that a crowd is building up.

Target team mapping by crowd type:
- onlooker -> police/security team (perimeter concern)
- media -> media/communications team
- family -> evacuation or triage team
- helper -> whichever team is most affected

Return ONLY valid JSON:
{
  "convergent_crowds": [
    {
      "casualty_type": "convergent_crowd",
      "location_lat": number (at an entry point),
      "location_lng": number (at an entry point),
      "floor_level": "G",
      "headcount": number (5-50 per group),
      "conditions": {
        "crowd_origin": "onlooker|media|family|helper",
        "behavior": "calm|anxious|aggressive|demanding|filming",
        "visible_description": "1-2 sentence description of what responders see",
        "obstruction_risk": "low|medium|high",
        "ideal_response_sequence": [{ "step": 1, "action": "string", "detail": "string" }],
        "required_equipment": [{ "item": "string", "quantity": 1, "purpose": "string" }],
        "required_personnel": { "role": "string", "count": number },
        "management_priority": "low|medium|high|critical"
      },
      "status": "identified",
      "appears_at_minutes": number (5-${Math.min(45, durationMinutes - 5)}),
      "destination_lat": number (toward the incident site or cordon area),
      "destination_lng": number (toward the incident site or cordon area),
      "destination_label": "string (e.g. 'toward incident perimeter')",
      "movement_speed_mpm": 72
    }
  ],
  "alert_injects": [
    {
      "trigger_time_minutes": number (SAME as the crowd's appears_at_minutes),
      "type": "intel brief",
      "title": "short (5-8 words) alert headline (e.g. 'News Crew Arriving at North Entrance')",
      "content": "1-2 sentence in-world description of what's happening — describe the crowd arriving and the potential impact on operations",
      "severity": "low|medium",
      "inject_scope": "team_specific",
      "target_teams": ["team name"],
      "requires_response": true
    }
  ]
}

RULES:
- Stagger arrival times: onlookers earliest (T+3-8), media next (T+8-15), family later (T+12-25), helpers scattered
- Each group spawns at an entry/exit point coordinate (or nearby if no entry points provided)
- destination coordinates should be partway between the entry point and the incident site (they move toward it)
- movement_speed_mpm: 72 for walking crowds, 40 for hesitant/family groups
- At least 1 onlooker group, 1 media group, 1 family group
- headcount: onlookers 15-50, media 3-10, family 5-20, helpers 5-15
- Vary obstruction_risk: media and family tend to be higher risk
- Each convergent_crowd entry MUST have a matching alert_inject with the SAME trigger_time_minutes as the crowd's appears_at_minutes`;

  const convergentBatches = isMeleeConvergent
    ? [
        {
          label: 'onlookers, media, family, and helpers',
          count: '2-4',
          focus: 'Smaller convergent groups for a localized melee attack.',
        },
      ]
    : [
        {
          label: 'onlooker and helper groups',
          count: '2-4',
          focus: 'Curious bystanders and self-appointed volunteers arriving at perimeter.',
        },
        {
          label: 'media and family groups',
          count: '2-4',
          focus:
            'News crews pushing for access and distraught family members searching for loved ones.',
        },
      ];

  const allCrowds: NonNullable<WarroomScenarioPayload['casualties']> = [];
  const allAlertInjects: NonNullable<WarroomScenarioPayload['time_injects']> = [];

  const batchPromises = convergentBatches.map(async (batch) => {
    const batchPrompt =
      systemPrompt.replace(
        /Generate 4-8 convergent crowd groups/,
        `Generate ${batch.count} convergent crowd groups`,
      ) + `\n\nFOCUS ON: ${batch.label}. ${batch.focus}`;
    const batchUserPrompt = `Generate ${batch.count} convergent ${batch.label} for "${narrative?.title || scenario_type}" at ${venue}.`;

    try {
      const parsed = await callOpenAi<{
        convergent_crowds?: WarroomScenarioPayload['casualties'];
        alert_injects?: WarroomScenarioPayload['time_injects'];
      }>(batchPrompt, batchUserPrompt, openAiApiKey, 4000);
      return {
        crowds: parsed.convergent_crowds ?? [],
        injects: parsed.alert_injects ?? [],
      };
    } catch (err) {
      logger.warn({ err, batch: batch.label }, 'Convergent crowd batch failed');
      return {
        crowds: [] as NonNullable<WarroomScenarioPayload['casualties']>,
        injects: [] as NonNullable<WarroomScenarioPayload['time_injects']>,
      };
    }
  });

  const results = await Promise.all(batchPromises);
  for (const r of results) {
    allCrowds.push(...r.crowds);
    allAlertInjects.push(...r.injects);
  }

  logger.info(
    {
      batches: convergentBatches.length,
      totalCrowds: allCrowds.length,
      totalInjects: allAlertInjects.length,
    },
    'Convergent crowd batch generation complete',
  );
  return {
    crowds: allCrowds.length > 0 ? allCrowds : undefined,
    alertInjects: allAlertInjects.length > 0 ? allAlertInjects : undefined,
  };
}

// ---------------------------------------------------------------------------
// Phase 4b2f — Equipment Palette Generation
// Collects all equipment requirements from hazards + casualties → unified list
// ---------------------------------------------------------------------------

async function generateScenarioEquipment(
  hazards?: WarroomScenarioPayload['hazards'],
  casualties?: WarroomScenarioPayload['casualties'],
  teamNames?: string[],
): Promise<WarroomScenarioPayload['equipment']> {
  const equipmentMap = new Map<
    string,
    {
      equipment_type: string;
      label: string;
      icon?: string;
      properties: Record<string, unknown>;
      applicable_teams: string[];
    }
  >();

  const normalizeTeam = (t: string) => t.toLowerCase().replaceAll(' ', '_').replaceAll('-', '_');

  const mergeTeams = (existing: string[], incoming: string[]) => {
    const set = new Set(existing.map(normalizeTeam));
    for (const t of incoming) set.add(normalizeTeam(t));
    return Array.from(set);
  };

  for (const h of hazards ?? []) {
    for (const eq of h.equipment_requirements ?? []) {
      const eqType = (eq.equipment_type as string) ?? '';
      if (!eqType) continue;
      const teams = Array.isArray(eq.applicable_teams) ? (eq.applicable_teams as string[]) : [];
      const existing = equipmentMap.get(eqType);
      if (existing) {
        existing.applicable_teams = mergeTeams(existing.applicable_teams, teams);
      } else {
        equipmentMap.set(eqType, {
          equipment_type: eqType,
          label: (eq.label as string) ?? eqType.replace(/_/g, ' '),
          icon: iconForEquipment(eqType),
          properties: {
            quantity_needed: (eq.quantity as number) ?? 1,
            critical: (eq.critical as boolean) ?? false,
            applicable_to: ['hazard'],
          },
          applicable_teams: teams.map(normalizeTeam),
        });
      }
    }

    const resReq = h.resolution_requirements ?? {};
    const reqEquipment = (resReq.equipment as string[]) ?? [];
    for (const eqType of reqEquipment) {
      if (eqType && !equipmentMap.has(eqType)) {
        equipmentMap.set(eqType, {
          equipment_type: eqType,
          label: eqType.replace(/_/g, ' '),
          icon: iconForEquipment(eqType),
          properties: { quantity_needed: 1, applicable_to: ['hazard'] },
          applicable_teams: [],
        });
      }
    }
  }

  const mobilityEquipment: Record<string, { label: string; icon: string; defaultTeams: string[] }> =
    {
      stretcher: { label: 'Stretcher', icon: 'bed', defaultTeams: ['evacuation', 'triage'] },
      spinal_board: {
        label: 'Spinal Board',
        icon: 'clipboard',
        defaultTeams: ['evacuation', 'triage'],
      },
      wheelchair: {
        label: 'Wheelchair',
        icon: 'accessibility',
        defaultTeams: ['evacuation', 'triage'],
      },
      cutting_tools: {
        label: 'Cutting Tools',
        icon: 'wrench',
        defaultTeams: ['fire_hazmat', 'evacuation'],
      },
      breathing_apparatus: {
        label: 'Breathing Apparatus',
        icon: 'wind',
        defaultTeams: ['fire_hazmat'],
      },
    };

  for (const c of casualties ?? []) {
    const conds = (c.conditions ?? {}) as Record<string, unknown>;
    const mobility = conds.mobility as string;
    if (mobility === 'non_ambulatory' || mobility === 'trapped') {
      if (!equipmentMap.has('stretcher')) {
        const me = mobilityEquipment.stretcher;
        equipmentMap.set('stretcher', {
          equipment_type: 'stretcher',
          label: me.label,
          icon: me.icon,
          properties: { quantity_needed: 1, applicable_to: ['non_ambulatory', 'trapped'] },
          applicable_teams: me.defaultTeams,
        });
      }
    }
    if (mobility === 'trapped') {
      if (!equipmentMap.has('cutting_tools')) {
        const me = mobilityEquipment.cutting_tools;
        equipmentMap.set('cutting_tools', {
          equipment_type: 'cutting_tools',
          label: me.label,
          icon: me.icon,
          properties: { quantity_needed: 1, applicable_to: ['trapped'] },
          applicable_teams: me.defaultTeams,
        });
      }
    }
    const accessibility = conds.accessibility as string;
    if (accessibility === 'in_smoke') {
      if (!equipmentMap.has('breathing_apparatus')) {
        const me = mobilityEquipment.breathing_apparatus;
        equipmentMap.set('breathing_apparatus', {
          equipment_type: 'breathing_apparatus',
          label: me.label,
          icon: me.icon,
          properties: { quantity_needed: 1, applicable_to: ['smoke_environment'] },
          applicable_teams: me.defaultTeams,
        });
      }
    }
  }

  // Items with empty applicable_teams get assigned to all teams (universal)
  const allTeamsNormalized = (teamNames ?? []).map(normalizeTeam);
  for (const entry of equipmentMap.values()) {
    if (entry.applicable_teams.length === 0) {
      entry.applicable_teams = allTeamsNormalized;
    }
  }

  const list = Array.from(equipmentMap.values());
  return list.length > 0 ? list : undefined;
}

function iconForEquipment(eqType: string): string {
  const iconMap: Record<string, string> = {
    foam_unit: 'droplet',
    fire_extinguisher: 'flame',
    thermal_camera: 'camera',
    breathing_apparatus: 'wind',
    hose_line: 'droplet',
    stretcher: 'bed',
    spinal_board: 'clipboard',
    cutting_tools: 'wrench',
    hydraulic_jack: 'wrench',
    defibrillator: 'heart',
    iv_kit: 'syringe',
    burn_kit: 'first-aid',
    splint: 'bone',
    oxygen_cylinder: 'wind',
    hazmat_suit: 'shield',
  };
  return iconMap[eqType] ?? 'package';
}

// ---------------------------------------------------------------------------
// Phase 4b3 — Floor Plan Generation  (3 000 tokens)
// Uses real building polygon from OSM + AI features → server-side SVG render
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function generateFloorPlans(
  input: WarroomGenerateInput,
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<WarroomScenarioPayload['floor_plans']> {
  const includeFloors = input.complexity_tier === 'full' || input.complexity_tier === 'rich';
  if (!includeFloors) return undefined;

  const mainBuilding = input.osmBuildings?.[0];
  const levels = mainBuilding?.building_levels ?? 1;
  if (levels <= 1) return undefined;

  onProgress?.('Generating multi-floor layout from building footprint...');

  const { scenario_type, setting, venue_name, location } = input;
  const venue = venue_name || location || setting;

  const undergroundLevels = mainBuilding?.building_levels_underground ?? 0;
  const buildingUse = mainBuilding?.building_use ?? setting;

  const floorList: string[] = [];
  for (let i = undergroundLevels; i > 0; i--) floorList.push(`B${i}`);
  floorList.push('G');
  for (let i = 1; i < levels; i++) floorList.push(`L${i}`);

  const hasPolygon = !!mainBuilding?.footprint_polygon?.length;
  const polygonNote = hasPolygon
    ? `The building has a real footprint polygon with ${mainBuilding!.footprint_polygon!.length} vertices from OSM.`
    : 'No polygon available; layout will use a rectangular approximation.';

  const boundsBlock = mainBuilding?.bounds
    ? `Building bounds: minLat=${mainBuilding.bounds.minlat}, maxLat=${mainBuilding.bounds.maxlat}, minLng=${mainBuilding.bounds.minlon}, maxLng=${mainBuilding.bounds.maxlon}`
    : '';

  const systemPrompt = `You are an expert building layout designer. You are placing features inside a ${buildingUse} for a crisis training exercise.

Scenario type: ${scenario_type}
Venue: ${venue} (${buildingUse})
Setting: ${setting}
Floors: ${floorList.join(', ')}
${boundsBlock}
${polygonNote}
${narrative ? `Narrative: ${narrative.title}` : ''}

IMPORTANT: Position each feature using NORMALISED coordinates (0.0 to 1.0):
- position_x: 0.0 = west edge, 1.0 = east edge
- position_y: 0.0 = north edge, 1.0 = south edge
- For area features, also provide size_x and size_y (0.0 to 1.0 fraction of building)

Place exits at edges (x near 0 or 1, or y near 0 or 1). Place central features (escalators, elevators) near the middle (0.4-0.6). Distribute rooms across the floor realistically.

Return ONLY valid JSON:
{
  "floor_plans": [
    {
      "floor_level": "G",
      "floor_label": "Ground Floor",
      "features": [
        {
          "id": "main_entrance_g",
          "type": "entrance",
          "label": "Main Entrance",
          "position_x": 0.5,
          "position_y": 1.0,
          "properties": { "capacity": 200, "width_m": 6 }
        },
        {
          "id": "food_court_g",
          "type": "food_court",
          "label": "Food Court",
          "position_x": 0.3,
          "position_y": 0.4,
          "size_x": 0.25,
          "size_y": 0.2,
          "properties": {}
        }
      ],
      "environmental_factors": [
        { "factor": "smoke_accumulation", "severity": "low" },
        { "factor": "crowd_density", "severity": "medium" }
      ]
    }
  ]
}

RULES:
- Each feature MUST have id, type, label, position_x (0-1), position_y (0-1)
- Area features (corridor, food_court, retail, room, parking, office, storage) also need size_x and size_y
- emergency_exit positions: on edges (x=0, x=1, y=0, or y=1)
- escalator/elevator/stairs: near center, consistent across floors
- Ground floor: main entrance, 3-4 emergency exits, retail/food areas
- Upper floors: escalators/stairs down, fire exits, retail/office
- Basement: parking, service areas, limited exits
- 6-10 features per floor
- Valid types: emergency_exit, escalator, elevator, stairs, entrance, room, corridor, food_court, retail, restroom, fire_extinguisher, fire_alarm, first_aid, electrical_panel, ventilation, water_supply, parking, office, storage`;

  const userPrompt = `Generate floor plans for ${floorList.length} floors of ${venue} (${buildingUse}). Floors: ${floorList.join(', ')}.`;

  try {
    const { generateFloorPlanSvg, convertFeaturesToGeoJson } =
      await import('./floorPlanSvgService.js');

    interface AiFloorPlan {
      floor_level: string;
      floor_label: string;
      features: Array<{
        id: string;
        type: string;
        label: string;
        position_x: number;
        position_y: number;
        size_x?: number;
        size_y?: number;
        properties?: Record<string, unknown>;
      }>;
      environmental_factors: Array<Record<string, unknown>>;
    }

    const parsed = await callOpenAi<{
      floor_plans?: AiFloorPlan[];
    }>(systemPrompt, userPrompt, openAiApiKey, 4000);

    if (!parsed.floor_plans?.length) return undefined;

    const polygon = mainBuilding?.footprint_polygon;
    const rectBounds = mainBuilding?.bounds ?? null;
    const leafletBounds = rectBounds
      ? {
          southWest: [rectBounds.minlat, rectBounds.minlon],
          northEast: [rectBounds.maxlat, rectBounds.maxlon],
        }
      : undefined;

    const results: NonNullable<WarroomScenarioPayload['floor_plans']> = [];

    for (const aiFloor of parsed.floor_plans) {
      // Generate SVG from real polygon + AI features
      const svg = generateFloorPlanSvg(polygon, rectBounds, {
        floor_level: aiFloor.floor_level,
        floor_label: aiFloor.floor_label,
        building_use: buildingUse,
        features: aiFloor.features.map((f) => ({
          id: f.id,
          type: f.type,
          label: f.label,
          position_x: Math.max(0, Math.min(1, f.position_x ?? 0.5)),
          position_y: Math.max(0, Math.min(1, f.position_y ?? 0.5)),
          size_x: f.size_x,
          size_y: f.size_y,
          properties: f.properties,
        })),
        environmental_factors: aiFloor.environmental_factors ?? [],
      });

      // Convert normalised feature positions to GeoJSON for map markers
      const geoFeatures = rectBounds
        ? convertFeaturesToGeoJson(
            aiFloor.features.map((f) => ({
              id: f.id,
              type: f.type,
              label: f.label,
              position_x: Math.max(0, Math.min(1, f.position_x ?? 0.5)),
              position_y: Math.max(0, Math.min(1, f.position_y ?? 0.5)),
              properties: f.properties,
            })),
            rectBounds,
          )
        : [];

      results.push({
        floor_level: aiFloor.floor_level,
        floor_label: aiFloor.floor_label,
        plan_svg: svg || undefined,
        bounds: leafletBounds,
        features: geoFeatures,
        environmental_factors: aiFloor.environmental_factors ?? [],
      });
    }

    logger.info(
      { floors: results.length, hasPolygon, polygonVertices: polygon?.length ?? 0 },
      'Floor plan SVGs generated from building footprint',
    );

    return results;
  } catch (err) {
    logger.warn({ err }, 'Floor plan generation failed; continuing without');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Phase 4c — Layout & Site Knowledge  (3 000 tokens)
// ---------------------------------------------------------------------------

async function generateLayoutAndSiteKnowledge(
  input: WarroomGenerateInput,
  teamNames: string[],
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
  locations?: WarroomScenarioPayload['locations'],
): Promise<{
  layout_ground_truth?: Record<string, unknown>;
  site_areas?: Array<Record<string, unknown>>;
  custom_facts?: Array<{ topic: string; summary: string; detail?: string }>;
  baseline_escalation_factors?: Array<{
    id: string;
    name: string;
    description: string;
    severity: string;
  }>;
}> {
  const includeKnowledge = input.complexity_tier === 'full' || input.complexity_tier === 'rich';
  if (!includeKnowledge) return {};

  onProgress?.('Generating layout and site knowledge...');

  const { scenario_type, setting, terrain, venue_name, location } = input;
  const venue = venue_name || location || setting;

  const locationsBlock = locations?.length
    ? `Map pins:\n${locations.map((l) => `- ${l.label} (${l.location_type})`).join('\n')}`
    : '';
  const routeLocations = locations?.filter((l) => l.location_type === 'route') ?? [];
  const routeSummary =
    routeLocations.length > 0
      ? `Routes:\n${routeLocations
          .map((r) => {
            const c = r.conditions as Record<string, unknown> | undefined;
            return `- ${r.label}: ${c?.problem || 'clear'}, ${c?.travel_time_minutes ?? '?'} min`;
          })
          .join('\n')}`
      : '';
  const narrativeBlock = narrative
    ? `NARRATIVE:\nTitle: ${narrative.title || ''}\nDescription: ${narrative.description || ''}`
    : '';

  const systemPrompt = `You are an expert crisis management scenario designer building insider knowledge for trainers.

Scenario type: ${scenario_type}
Venue: ${venue}
Setting: ${setting} | Terrain: ${terrain}
Teams: ${teamNames.join(', ')}
${narrativeBlock}
${locationsBlock}
${routeSummary}

IMPORTANT: This is a ${scenario_type} scenario. ALL content — areas, exits, facts, and escalation factors — must be specific to how a ${scenario_type} actually unfolds. Do NOT generate mass-casualty-incident content (triage zones, stretcher routes, secondary explosives, crowd surges, casualty counts) unless this scenario genuinely involves those elements.

Return ONLY valid JSON with these keys:
{
  "layout_ground_truth": {
    "total_capacity": number,
    "exits": [ { "id": "string", "label": "string — name relevant to this ${scenario_type}", "status": "open|blocked|compromised", "throughput": "string — describe flow in terms relevant to this scenario (people/min, vehicles/hour, etc.)" } ],
    "zones": [ { "zone_id": "string", "label": "string — zone name specific to this ${scenario_type}", "description": "string" } ],
    "incident_site": { "description": "string — describes the primary incident location in ${scenario_type} terms", "radius_m": number }
  },
  "site_areas": [
    { "area_id": "string", "label": "string — area name specific to this ${scenario_type}", "capacity": number, "area_m2": number, "hazards": ["string — hazards relevant to this scenario type"], "vehicle_access": boolean, "restricted_access": boolean }
  ],
  "custom_facts": [
    { "topic": "string", "summary": "string", "detail": "string (optional)" }
  ],
  "baseline_escalation_factors": [
    { "id": "string", "name": "string", "description": "string", "severity": "critical|high|medium" }
  ]
}

RULES:
- layout_ground_truth: the physical venue structure as it relates to THIS ${scenario_type}. Zones and exits should reflect the scenario (e.g. for kidnapping: "Perimeter Zone", "Negotiation Approach Corridor"; for fire: "Stairwell B", "Roof Access").
- site_areas: If the scenario locations already carry rich conditions (capacity_persons, has_water, has_electricity, area_m2, potential_uses, etc.), return an EMPTY site_areas array [] — the location conditions are the source of truth. Otherwise, generate 3–5 operational areas that teams in THIS scenario actually use. Name them for this incident type — NOT generic MCI area names unless this is an MCI.
- custom_facts: 4–6 trainer-only insider facts that are specific to this ${scenario_type} — intelligence gaps, political sensitivities, known perpetrator behaviours, environmental constraints, known unknowns.
- baseline_escalation_factors: 2–4 risks specific to THIS ${scenario_type} that escalate if teams perform poorly. Examples must match the incident type (e.g. for kidnapping: "Hostage Transfer", "Ransom Deadline", "Intelligence Leak"; for fire: "Structural Collapse", "Civilian Entrapment"; for bombing: "Secondary Device", "Crowd Surge"). Do NOT use bombing/MCI examples for non-bombing scenarios.`;

  const userPrompt = `Build layout and site knowledge for "${narrative?.title || scenario_type}" at ${venue}.`;

  try {
    const parsed = await callOpenAi<{
      layout_ground_truth?: Record<string, unknown>;
      site_areas?: Array<Record<string, unknown>>;
      custom_facts?: Array<{ topic: string; summary: string; detail?: string }>;
      baseline_escalation_factors?: Array<{
        id: string;
        name: string;
        description: string;
        severity: string;
      }>;
    }>(systemPrompt, userPrompt, openAiApiKey, 3000);

    return {
      layout_ground_truth: parsed.layout_ground_truth || undefined,
      site_areas: parsed.site_areas?.length ? parsed.site_areas : undefined,
      custom_facts: parsed.custom_facts?.length ? parsed.custom_facts : undefined,
      baseline_escalation_factors: parsed.baseline_escalation_factors?.length
        ? parsed.baseline_escalation_factors
        : undefined,
    };
  } catch (err) {
    logger.warn({ err }, 'Phase 4c layout/site knowledge failed; continuing without');
    return {};
  }
}

// ---------------------------------------------------------------------------
// Phase 4d — Team Intelligence Dossiers  (1 call per team · ~2 500 tokens each)
// ---------------------------------------------------------------------------

interface TeamDossierEntry {
  question: string;
  category: string;
  answer: string;
}

async function generateSingleTeamDossier(
  teamName: string,
  teamDescription: string,
  input: WarroomGenerateInput,
  allTeamNames: string[],
  openAiApiKey: string,
  narrative?: { title?: string; description?: string; briefing?: string },
  locations?: WarroomScenarioPayload['locations'],
  phase4c?: {
    layout_ground_truth?: Record<string, unknown>;
    site_areas?: Array<Record<string, unknown>>;
    custom_facts?: Array<{ topic: string; summary: string; detail?: string }>;
    baseline_escalation_factors?: Array<{
      id: string;
      name: string;
      description: string;
      severity: string;
    }>;
  },
): Promise<TeamDossierEntry[]> {
  const { scenario_type, setting, terrain, venue_name, location, osm_vicinity } = input;
  const venue = venue_name || location || setting;

  const narrativeBlock = narrative
    ? `\nNARRATIVE:\nTitle: ${narrative.title || ''}\nDescription: ${narrative.description || ''}\nBriefing: ${narrative.briefing || ''}`
    : '';
  const locationsBlock = locations?.length
    ? `\nMap pins:\n${locations.map((l) => `- ${l.label} (${l.location_type}): ${l.description || ''}`).join('\n')}`
    : '';
  const osmBlock = osm_vicinity
    ? `\nNearby facilities — Hospitals: ${osm_vicinity.hospitals?.map((h) => h.name).join(', ') || 'None'}; Police: ${osm_vicinity.police?.map((p) => p.name).join(', ') || 'None'}; Fire: ${osm_vicinity.fire_stations?.map((f) => f.name).join(', ') || 'None'}`
    : '';
  const routeLocs = locations?.filter((l) => l.location_type === 'route') ?? [];
  const routeSummary =
    routeLocs.length > 0
      ? `\nRoutes:\n${routeLocs
          .map((r) => {
            const c = r.conditions as Record<string, unknown> | undefined;
            return `- ${r.label}: ${c?.problem || 'clear'}, ${c?.travel_time_minutes ?? '?'} min`;
          })
          .join('\n')}`
      : '';
  const factsBlock = phase4c?.custom_facts?.length
    ? `\nScenario facts:\n${phase4c.custom_facts.map((f) => `- ${f.topic}: ${f.detail || f.summary}`).join('\n')}`
    : '';
  const escalationBlock = phase4c?.baseline_escalation_factors?.length
    ? `\nEscalation risks:\n${phase4c.baseline_escalation_factors.map((e) => `- ${e.name} (${e.severity}): ${e.description}`).join('\n')}`
    : '';
  const layoutBlock = phase4c?.layout_ground_truth
    ? `\nLayout: ${JSON.stringify(phase4c.layout_ground_truth, null, 1).slice(0, 600)}`
    : '';

  const systemPrompt = `You are an expert crisis management scenario designer building a detailed INTELLIGENCE DOSSIER for one specific team in a training exercise.

Scenario type: ${scenario_type}
Venue: ${venue}
Setting: ${setting} | Terrain: ${terrain}
All teams: ${allTeamNames.join(', ')}
${narrativeBlock}
${locationsBlock}
${osmBlock}
${routeSummary}
${factsBlock}
${escalationBlock}
${layoutBlock}

TARGET TEAM: "${teamName}"
TEAM ROLE: ${teamDescription}

Your task: Think about what a "${teamName}" team would ACTUALLY need to know from a well-informed insider during a ${scenario_type} incident. Generate 10–15 questions they would realistically ask, along with rich, detailed answers grounded in this specific scenario.

Each answer must be 3–6 sentences with SPECIFIC details: names of people, organizations, locations, numbers, timestamps, conditions, sentiments. Invent realistic details that are CONSISTENT with the scenario context — real-sounding names, plausible organizations, concrete numbers.

Return ONLY valid JSON:
{
  "dossier": [
    {
      "question": "string — a natural question this team would ask the insider",
      "category": "string — short snake_case category (e.g. public_sentiment, media_presence, resource_status, suspect_profile, witness_accounts, infrastructure_status, weather_conditions, crowd_behavior, political_pressure, supply_chain, communication_lines, legal_authority, chain_of_command, intelligence_feeds, hazmat_status, structural_integrity, casualty_profile, transport_availability, community_relations, misinformation, vip_presence)",
      "answer": "string — 3-6 sentences of rich, specific, scenario-grounded intelligence"
    }
  ]
}

RULES:
- Questions must be specific to what a "${teamName}" team needs during a ${scenario_type}. Think about their operational concerns, information gaps, and decision-making needs.
- Answers must reference specific scenario details: the venue name, location, nearby facilities, scenario narrative.
- Invent realistic supporting details (people names, organization names, specific numbers, timestamps) that are consistent with the scenario but add depth.
- Cover a WIDE range of information needs — don't cluster around one topic. Include situational awareness, resource status, stakeholder dynamics, environmental conditions, and operational constraints.
- Do NOT repeat information verbatim from the scenario briefing — add NEW intelligence that enriches the picture.
- Every answer should give the team something ACTIONABLE or help them make better decisions.`;

  const userPrompt = `Build the intelligence dossier for the "${teamName}" team in "${narrative?.title || scenario_type}" at ${venue}.`;

  const parsed = await callOpenAi<{ dossier?: TeamDossierEntry[] }>(
    systemPrompt,
    userPrompt,
    openAiApiKey,
    3000,
  );
  return parsed.dossier?.length ? parsed.dossier : [];
}

async function generateTeamIntelligenceDossiers(
  input: WarroomGenerateInput,
  teamNames: string[],
  teams: WarroomScenarioPayload['teams'],
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
  locations?: WarroomScenarioPayload['locations'],
  phase4c?: {
    layout_ground_truth?: Record<string, unknown>;
    site_areas?: Array<Record<string, unknown>>;
    custom_facts?: Array<{ topic: string; summary: string; detail?: string }>;
    baseline_escalation_factors?: Array<{
      id: string;
      name: string;
      description: string;
      severity: string;
    }>;
  },
): Promise<Record<string, TeamDossierEntry[]> | undefined> {
  const includeDossiers = input.complexity_tier === 'full' || input.complexity_tier === 'rich';
  if (!includeDossiers) return undefined;

  onProgress?.('Generating team intelligence dossiers...');

  try {
    const results = await Promise.all(
      teams.map((t) =>
        generateSingleTeamDossier(
          t.team_name,
          t.team_description,
          input,
          teamNames,
          openAiApiKey,
          narrative,
          locations,
          phase4c,
        ),
      ),
    );

    const dossiers: Record<string, TeamDossierEntry[]> = {};
    for (let i = 0; i < teams.length; i++) {
      if (results[i].length > 0) {
        dossiers[teams[i].team_name] = results[i];
      }
    }

    return Object.keys(dossiers).length > 0 ? dossiers : undefined;
  } catch (err) {
    logger.warn({ err }, 'Phase 4d team intelligence dossiers failed; continuing without');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Phase 2a — Universal time-based injects  (1 call · 1 500 tokens)
// ---------------------------------------------------------------------------

/**
 * Generates scene-setting injects visible to ALL teams, anchored to pre-assigned universal slots.
 * These establish the narrative arc: setup → escalation → peak → resolution.
 */
async function generateUniversalTimeInjects(
  input: WarroomGenerateInput,
  teamNames: string[],
  openAiApiKey: string,
  universalSlots: number[],
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<WarroomScenarioPayload['time_injects']> {
  onProgress?.('Generating universal time-based injects...');

  const { scenario_type, setting, terrain, venue_name, location, osm_vicinity, researchContext } =
    input;
  const venue = venue_name || location || setting;

  const osmBlock = osm_vicinity
    ? `Real facilities — Hospitals: ${osm_vicinity.hospitals?.map((h) => h.name).join(', ') || 'None'}; Police: ${osm_vicinity.police?.map((p) => p.name).join(', ') || 'None'}; Fire: ${osm_vicinity.fire_stations?.map((f) => f.name).join(', ') || 'None'}`
    : '';
  const standardsBlock =
    researchContext?.standards_findings && researchContext.standards_findings.length > 0
      ? `\nStandards:\n${standardsToPromptBlock(researchContext.standards_findings)}`
      : researchContext?.standards_summary
        ? `\nStandards: ${researchContext.standards_summary}`
        : '';
  const researchBlock = buildResearchContextBlock(researchContext, venue);
  const narrativeBlock = narrative
    ? `\nNARRATIVE: ${narrative.title || ''} — ${narrative.description || ''}`
    : '';

  const slotDescriptions = universalSlots
    .map((t) => `T+${t} [${getPhaseLabelShort(t)}]`)
    .join(', ');

  const systemPrompt = `You are an expert crisis management scenario designer writing EXTERNAL WORLD injects visible to ALL teams simultaneously. These represent events OUTSIDE player control — things happening in the world around the crisis that players must react to but cannot prevent through their operational decisions.

Scenario: ${scenario_type} at ${venue}
Setting: ${setting} | Terrain: ${terrain}
Teams: ${teamNames.join(', ')}
${osmBlock}
${standardsBlock}
${researchBlock}
${narrativeBlock}

${
  input.inject_profiles?.length && input.inject_profiles.length >= 2
    ? buildThematicEmphasisBlock(input.inject_profiles, 'universal')
    : `WHAT TO GENERATE — reason from the venue research and similar incidents above:
- What external political or diplomatic pressures would this specific location attract?
- What infrastructure (power, water, transport, comms) is vulnerable at THIS venue and could cascade?
- What media dynamics are realistic for this locale — local press culture, social media penetration, language diversity?
- What community and cultural tensions exist in this area that the incident could inflame?
- What environmental or weather complications are plausible for this geography and season?
- What black swan complications arose in the similar real incidents listed above?
Do NOT default to generic tropes. Every inject must be grounded in something specific to this venue, locale, or the research context provided.`
}

WHAT THESE INJECTS ARE NOT (these are handled by real-time condition monitoring):
- Overcrowding in triage or assembly areas
- Staff shortages or carer-to-patient ratios
- Equipment shortages in operational areas
- Exit congestion or evacuation flow problems
- Patient deterioration or casualty status changes

The game runs for ${input.duration_minutes ?? 60} minutes. Arc the external narrative: initial shock → pressure builds → complications escalate → resolution pressure.

Return ONLY valid JSON:
{
  "time_injects": [
    {
      "trigger_time_minutes": 0,
      "type": "field_update|media_report|intel_brief|weather_change|political_pressure|black_swan",
      "title": "string",
      "content": "string — 2-3 sentences, specific to THIS scenario and venue",
      "severity": "critical|high|medium|low",
      "inject_scope": "universal",
      "target_teams": [],
      "requires_response": true,
      "requires_coordination": false
    }
  ]
}

RULES:
- Exactly ${universalSlots.length} injects. Assigned times: ${slotDescriptions}.
- Each inject MUST use its exact assigned trigger_time_minutes — no substitutions.
- inject_scope is always "universal". target_teams is always [].
- Each inject must reference the specific scenario title, venue, and narrative details.
- No operational/logistical injects (no "triage is overwhelmed" or "exit congested") — those emerge from gameplay.
- requires_response: set to true when teams must react (e.g. political demand, media confrontation, secondary threat). false ONLY for atmospheric pressure (background news, social media chatter).
- Each inject title must be concretely different from the others — no two should share the same underlying theme, character archetype, or scenario element.

DO NOT generate a T+0 inject. The initial incident report at T+0 is handled separately and must not be duplicated here. Your first inject should be at the earliest assigned time slot.

THEME UNIQUENESS:
- Each inject must address a COMPLETELY DIFFERENT scenario element. No two injects may share the same character archetype (impersonator, veteran, family member), the same crisis trope (false rumor, cordon breach, secondary device), or the same social dynamic (media frenzy, political pressure).
- If two injects could be summarised with the same 3-word phrase (e.g. "fake medical worker", "parents demand access"), they are duplicates — remove one.
${
  !input.inject_profiles?.length
    ? `
VARIETY IS CRITICAL:
- Do NOT default to generic patterns. Every inject must be grounded in the venue research, similar incidents, or local geography provided above.
- Use THIS venue's real infrastructure, community, and cultural context to create complications that could not happen at a generic location.
- Surprise the players. Avoid predictable crisis-management tropes.`
    : ''
}`;

  const userPrompt = `Write ${universalSlots.length} universal injects for "${narrative?.title || scenario_type}" at ${venue} at times: ${slotDescriptions}. Prioritize unusual, location-specific, and surprising events over generic crisis tropes.`;

  try {
    const parsed = await callOpenAi<{ time_injects?: WarroomScenarioPayload['time_injects'] }>(
      systemPrompt,
      userPrompt,
      openAiApiKey,
      5000,
      0.95,
    );
    const raw = (parsed.time_injects || []).filter(
      (inj) => inj.trigger_time_minutes !== 0 && inj.trigger_time_minutes != null,
    );
    return raw.map((inj) => ({
      ...inj,
      trigger_time_minutes: inj.trigger_time_minutes ?? 5,
      type: normalizeInjectType(inj.type || 'field_update'),
      title: inj.title || 'Situation update',
      content: inj.content || '',
      severity: inj.severity || 'high',
      inject_scope: 'universal',
      target_teams: [] as string[],
      requires_response: inj.requires_response ?? true,
      requires_coordination: inj.requires_coordination ?? false,
    }));
  } catch (err) {
    logger.warn({ err }, 'Universal time injects failed; continuing without');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Phase 2b — Per-team time-based injects  (1 call per team · 1 200 tokens)
// ---------------------------------------------------------------------------

/**
 * Generates deep team-specific operational injects for a single team.
 * Each call focuses entirely on one team's role, operational challenges, and arc within the scenario.
 */
async function generateTeamTimeInjects(
  input: WarroomGenerateInput,
  teamName: string,
  allTeamNames: string[],
  openAiApiKey: string,
  assignedSlots: number[],
  narrative?: { title?: string; description?: string; briefing?: string },
  existingTitles?: string[],
): Promise<WarroomScenarioPayload['time_injects']> {
  if (assignedSlots.length === 0) return [];

  const { scenario_type, setting, terrain, venue_name, location, researchContext } = input;
  const venue = venue_name || location || setting;

  const narrativeBlock = narrative
    ? `\nNARRATIVE: ${narrative.title || ''} — ${narrative.description || ''}\n${(narrative.briefing || '').slice(0, 300)}`
    : '';
  const researchBlock = buildResearchContextBlock(researchContext, venue);

  const existingTitlesBlock = existingTitles?.length
    ? `\nALREADY GENERATED — BANNED THEMES (do NOT repeat these themes, character types, scenario elements, or similar ideas. Each entry shows "Title: brief content"):\n${existingTitles.map((t) => `- ${t}`).join('\n')}`
    : '';

  const slotsWithPhase = assignedSlots.map((t) => `T+${t} [${getPhaseLabelShort(t)}]`).join(', ');

  const systemPrompt = `You are an expert crisis management scenario designer writing EXTERNAL WORLD events EXCLUSIVELY for the ${teamName} team. These are events that happen TO this team from the outside world — things they cannot prevent through operational decisions but must react to.

Scenario: ${scenario_type} at ${venue}
Setting: ${setting} | Terrain: ${terrain}
All teams in this exercise: ${allTeamNames.join(', ')}
THIS inject set is ONLY for: ${teamName}
${narrativeBlock}
${researchBlock}
${existingTitlesBlock}

${
  input.inject_profiles?.length && input.inject_profiles.length >= 2
    ? buildThematicEmphasisBlock(input.inject_profiles, 'team', teamName)
    : `WHAT TO GENERATE — external events specific to ${teamName}'s domain:
- What real-world complications did similar incidents cause for teams like ${teamName}?
- What local infrastructure, cultural norms, or geography would create unique problems for ${teamName} at THIS venue?
- What inter-agency dynamics are realistic for this jurisdiction?
- What civilian behaviors specific to this community would pressure ${teamName}?
Do NOT default to generic crisis management props (fake doctors, family breaching cordons) unless the research context specifically supports it for THIS venue.`
}

WHAT THESE INJECTS ARE NOT (handled by real-time area monitors):
- "Your triage is overcrowded" — this is detected automatically by area capacity monitoring
- "Not enough medics" — detected by carer-ratio monitoring
- "Exit is congested" — detected by exit flow monitoring
- "Equipment shortage" — detected by equipment monitoring
- Any patient status change or deterioration — handled by deterioration services

The game runs for ${input.duration_minutes ?? 60} minutes. Arc the ${teamName}'s external narrative:
- Setup (T+0–${Math.round((input.duration_minutes ?? 60) * 0.25)}): ${teamName} encounters their first external complication.
- Escalation (T+${Math.round((input.duration_minutes ?? 60) * 0.25)}–${Math.round((input.duration_minutes ?? 60) * 0.55)}): An outside force raises the stakes for ${teamName}.
- Peak (T+${Math.round((input.duration_minutes ?? 60) * 0.55)}–${Math.round((input.duration_minutes ?? 60) * 0.85)}): A black swan or worst-case external event.
- Resolution (T+${Math.round((input.duration_minutes ?? 60) * 0.85)}–${input.duration_minutes ?? 60}): External consequence or relief.

Return ONLY valid JSON:
{
  "time_injects": [
    {
      "trigger_time_minutes": <exact value from: ${assignedSlots.join(', ')}>,
      "type": "field_update|citizen_call|intel_brief|media_report|political_pressure|black_swan",
      "title": "string — specific external event hitting ${teamName}",
      "content": "string — 2-4 sentences, vivid and specific to ${teamName}'s role",
      "severity": "critical|high|medium|low",
      "inject_scope": "team_specific",
      "target_teams": ["${teamName}"],
      "requires_response": true,
      "requires_coordination": false
    }
  ]
}

RULES:
- Exactly ${assignedSlots.length} injects using EXACTLY these times: ${slotsWithPhase}.
- inject_scope always "team_specific". target_teams always ["${teamName}"].
- No operational/logistical status updates — only external world events.
- No two injects should address the same challenge, character archetype, or scenario element.
- requires_response: true when ${teamName} must act. false ONLY for atmospheric pressure.
${existingTitlesBlock ? `- STRICTLY FORBIDDEN: The "ALREADY GENERATED" list above shows themes from universal injects and other teams. You MUST NOT create injects that overlap with ANY theme, character type (impersonator, veteran, family member, VIP), crisis trope (false rumor, cordon breach, stampede), or social dynamic from that list. Violating this rule makes the scenario unusable.` : ''}
${
  !input.inject_profiles?.length
    ? `
VARIETY IS CRITICAL:
- Do NOT recycle generic tropes — every inject must be grounded in the venue research, similar incidents, or local context provided above.
- Use THIS venue's real infrastructure, community dynamics, and geography to create complications unique to this locale.
- Every inject title must be concretely different from every other inject in this scenario.`
    : ''
}`;

  const userPrompt = `Write ${assignedSlots.length} deep team-specific injects for ${teamName} at: ${slotsWithPhase} in "${narrative?.title || scenario_type}" at ${venue}. Be creative and avoid generic crisis tropes.`;

  try {
    const parsed = await callOpenAi<{ time_injects?: WarroomScenarioPayload['time_injects'] }>(
      systemPrompt,
      userPrompt,
      openAiApiKey,
      5000,
      0.95,
    );
    const raw = parsed.time_injects || [];
    return raw.map((inj) => ({
      ...inj,
      trigger_time_minutes: inj.trigger_time_minutes ?? assignedSlots[0],
      type: normalizeInjectType(inj.type || 'field_update'),
      title: inj.title || `${teamName} update`,
      content: inj.content || '',
      severity: inj.severity || 'medium',
      inject_scope: 'team_specific',
      target_teams: [teamName],
      requires_response: inj.requires_response ?? true,
      requires_coordination: inj.requires_coordination ?? false,
    }));
  } catch (err) {
    logger.warn({ err, teamName }, 'Team time injects failed; continuing without');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Phase 2c — Per-team chaos/wildcard injects  (1 call per team · 3 000 tokens)
// ---------------------------------------------------------------------------

/**
 * Generates non-procedural, socially volatile, emotionally charged wildcard events
 * specific to each team's domain. These are CONDITION-BASED: they trigger when
 * specific game state conditions are met, not at fixed times.
 */
async function generateChaosInjects(
  input: WarroomGenerateInput,
  teamName: string,
  allTeamNames: string[],
  openAiApiKey: string,
  chaosCount: number,
  narrative?: { title?: string; description?: string; briefing?: string },
  existingTitles?: string[],
): Promise<NonNullable<WarroomScenarioPayload['condition_driven_injects']>> {
  if (chaosCount <= 0) return [];

  const { scenario_type, setting, venue_name, location, researchContext } = input;
  const venue = venue_name || location || setting;
  const durationMinutes = input.duration_minutes ?? 60;

  const narrativeBlock = narrative
    ? `\nNARRATIVE: ${narrative.title || ''} — ${narrative.description || ''}`
    : '';
  const researchBlock = buildResearchContextBlock(researchContext, venue);

  const systemPrompt = `You are a crisis simulation chaos designer. Your job is to generate unpredictable, socially volatile, emotionally charged wildcard events for the ${teamName} team. These are NOT operational or procedural events — they are the messy human reality of a crisis.

These chaos events are CONDITION-BASED: instead of firing at a fixed time, each inject specifies CONDITIONS that must be true in the game state before the inject appears. This makes them reactive to player actions and game progression.

Scenario: ${scenario_type} at ${venue}
All teams: ${allTeamNames.join(', ')}
Focus team: ${teamName}
Game duration: ${durationMinutes} minutes
${narrativeBlock}
${researchBlock}

${
  input.inject_profiles?.length && input.inject_profiles.length >= 2
    ? buildThematicEmphasisBlock(input.inject_profiles, 'chaos', teamName)
    : `WHAT TO GENERATE — unpredictable human chaos events for ${teamName}:
- What irrational crowd behaviors did the similar incidents document?
- What cultural, religious, or community dynamics at THIS location could erupt under crisis pressure?
- What social media and misinformation patterns are realistic for this population and locale?
- What ethical dilemmas or cultural sensitivity clashes are specific to this community?
Use the crowd dynamics research and area research above to ground every event in local reality. Do NOT default to generic chaos tropes — every event must be specific to this venue and community.`
}

AVAILABLE CONDITION KEYS (use these in conditions_to_appear):
- "casualties_at_assembly_above_20" — people have gathered at assembly areas
- "patients_in_treatment_above_5" — medical treatment is underway
- "active_fires_above_0" — fires are still burning
- "convergent_crowd_present" — onlookers/media/family have arrived from outside
- "no_zone_identification_decision" — players have not drawn any hazard zones
- "no_perimeter_establishment_decision" — no cordon/perimeter placed
- "exits_congested" — at least one exit has congestion
- "no_media_management_decision" — no media statement has been issued
- "crowd_density_above_0.6" — crowd density is dangerously high
- "objective_evacuation_not_completed" — evacuation objective is still active

AVAILABLE STATE EFFECT KEYS (mechanical disruptions the inject causes):
- evacuation_state.flow_rate_modifier — multiplier on exit flow rate (e.g. 0.5 = halved, 0.3 = severe)
- movement_state.speed_modifier — multiplier on crowd/patient movement speed (e.g. 0.6 = slowed)
- triage_state.treatment_time_modifier — multiplier on treatment duration (e.g. 1.5 = 50% longer)

Return ONLY valid JSON:
{
  "condition_injects": [
    {
      "type": "citizen_call|field_update|media_report|intel_brief",
      "title": "string — vivid, specific headline of the chaos event",
      "content": "string — 2-4 sentences describing the situation viscerally, with specific details",
      "severity": "critical|high|medium",
      "inject_scope": "team_specific",
      "target_teams": ["${teamName}"],
      "requires_response": true,
      "conditions_to_appear": {
        "threshold": 1,
        "conditions": ["condition_key_1", "condition_key_2"]
      },
      "conditions_to_cancel": ["condition_key_that_resolves_this"],
      "eligible_after_minutes": 5,
      "state_effect": {
        "evacuation_state": { "flow_rate_modifier": 0.5 }
      }
    }
  ]
}

RULES:
- Exactly ${chaosCount} injects.
- inject_scope always "team_specific". target_teams always ["${teamName}"].
- Every inject must be a NON-PROCEDURAL chaos event.
- Each inject must have conditions_to_appear with 1-3 condition keys from the list above.
- threshold: how many conditions must be true (1 = any of them, 2+ = multiple must co-occur).
- conditions_to_cancel: 1-2 keys that, if true, mean the chaos has been addressed and the inject should NOT fire.
- eligible_after_minutes: earliest game time this can fire (stagger: some at 5, some at 10-15, some at 20+).
- state_effect: include a mechanical disruption for at least half the injects. Use realistic modifiers (0.3-0.8 for slowdowns, 1.3-2.0 for time increases). Leave state_effect as {} for purely narrative injects.
- Be bold and uncomfortable — real crises involve racism, grief, anger, and panic. Do not sanitize.
- Make events culturally and geographically specific to ${venue}.
${existingTitles?.length ? `\nSTRICTLY FORBIDDEN THEMES (these have already been generated — do NOT create chaos injects that overlap with ANY of these themes, character types, or scenario elements):\n${existingTitles.map((t) => `- ${t}`).join('\n')}` : ''}
${
  !input.inject_profiles?.length
    ? `
VARIETY IS CRITICAL:
- Each chaos event must explore a DIFFERENT human dynamic — avoid multiple events about the same type of social friction.
- Use the venue research and similar incidents to find complications unique to THIS locale — do not recycle generic tropes.
- Every chaos event must be grounded in the real cultural, geographic, or social context of the venue.`
    : ''
}`;

  const userPrompt = `Write ${chaosCount} condition-based chaos/wildcard injects for ${teamName} in "${narrative?.title || scenario_type}" at ${venue}. Each must be a distinct, non-procedural social/human chaos event with game-state conditions that trigger it. Be maximally creative — ground events in the venue research and local context provided.`;

  try {
    const parsed = await callOpenAi<{
      condition_injects?: Array<{
        type?: string;
        title?: string;
        content?: string;
        severity?: string;
        inject_scope?: string;
        target_teams?: string[];
        requires_response?: boolean;
        conditions_to_appear?: { threshold?: number; conditions?: string[] } | { all: string[] };
        conditions_to_cancel?: string[];
        eligible_after_minutes?: number;
        state_effect?: Record<string, unknown>;
      }>;
    }>(systemPrompt, userPrompt, openAiApiKey, 4000, 0.95);

    const raw = parsed.condition_injects || [];
    return raw.map((inj) => ({
      type: normalizeInjectType(inj.type || 'citizen_call'),
      title: inj.title || `${teamName} wildcard event`,
      content: inj.content || '',
      severity: inj.severity || 'high',
      inject_scope: 'team_specific',
      target_teams: [teamName],
      requires_response: inj.requires_response ?? true,
      conditions_to_appear: inj.conditions_to_appear ?? { threshold: 1, conditions: [] },
      conditions_to_cancel: inj.conditions_to_cancel,
      eligible_after_minutes: inj.eligible_after_minutes ?? 5,
      state_effect:
        inj.state_effect && Object.keys(inj.state_effect).length > 0 ? inj.state_effect : undefined,
    }));
  } catch (err) {
    logger.warn({ err, teamName }, 'Chaos injects failed; continuing without');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — (removed: generic decision-based injects replaced by condition-driven injects)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase 5 — Adversary Pursuit Decision Tree  (1 call · 6 000 tokens)
// ---------------------------------------------------------------------------

export interface AdversaryProfile {
  adversary_id: string;
  adversary_type: string;
  label: string;
  behavior_profile: string;
  weapon_type: string;
  initial_zone: string;
  status: 'active' | 'barricaded' | 'fleeing' | 'neutralized' | 'escaped';
  pursuit_phase_gates: string[];
}

export interface AdversaryPursuitResult {
  adversary_profiles: AdversaryProfile[];
  pursuit_time_injects: WarroomScenarioPayload['time_injects'];
  pursuit_condition_injects: NonNullable<WarroomScenarioPayload['condition_driven_injects']>;
  pursuit_gates: Array<{
    gate_id: string;
    gate_order: number;
    check_at_minutes: number;
    condition: {
      team?: string;
      decision_types?: string[];
      content_hints: string[];
      min_hints?: number;
    };
  }>;
  last_known_pins: Array<{
    location_type: string;
    pin_category: 'last_known_adversary';
    label: string;
    coordinates: { lat: number; lng: number };
    visible_to_teams: string[];
    conditions: Record<string, unknown>;
  }>;
}

/**
 * Detect whether the user's free-text prompt or the generated narrative describes
 * an adversary who can be pursued (fleeing suspect, active shooter, chase, etc.).
 * Returns true if pursuit-related language is found.
 */
function detectPursuitIntentFromText(...texts: (string | undefined | null)[]): boolean {
  const PURSUIT_PATTERNS = [
    /flee|fleeing|fled|escape|escap/i,
    /chas(e|ed|ing)/i,
    /suspect.*(run|flee|escape|at.large|on.the.loose)/i,
    /gunman.*(moving|roam|active)/i,
    /pursu(e|it|ing)/i,
    /on.the.run/i,
    /manhunt/i,
    /track(ing)?.*(suspect|perpetrator|attacker|gunman)/i,
    /adversary.*(movement|moving|active|flee)/i,
    /hunt(ing)?.*(suspect|perpetrator|attacker)/i,
    /accomplice.*(flee|escape|run)/i,
    /secondary.*(attacker|suspect)/i,
    /wanted.*(individual|person|suspect)/i,
  ];
  const combined = texts.filter(Boolean).join(' ');
  if (!combined) return false;
  return PURSUIT_PATTERNS.some((p) => p.test(combined));
}

/**
 * Generate an adversary pursuit decision tree.
 *
 * Three-way resolution for whether to generate:
 *  1. User's free-text prompt mentions adversary/chase/fleeing → YES (auto-override)
 *  2. Trainer toggled "include_adversary_pursuit" ON → YES
 *  3. Otherwise → NO (even if template has_adversary is true)
 *
 * All adversary waypoints use coordinates from the already-generated locations array.
 */
export async function generateAdversaryPursuitTree(
  input: WarroomGenerateInput,
  locations: Array<{
    location_type: string;
    pin_category?: string;
    label: string;
    coordinates: { lat: number; lng: number };
  }>,
  teamNames: string[],
  openAiApiKey: string,
  narrative?: { title?: string; description?: string; briefing?: string },
  onProgress?: WarroomAiProgressCallback,
  trainerToggle?: boolean,
): Promise<AdversaryPursuitResult | null> {
  const promptDetected = detectPursuitIntentFromText(
    input.original_prompt,
    narrative?.title,
    narrative?.description,
    narrative?.briefing,
  );

  const shouldGenerate = promptDetected || trainerToggle === true;
  if (!shouldGenerate) {
    logger.info('Adversary pursuit: skipped (toggle off, no pursuit language detected)');
    return null;
  }

  if (promptDetected && !trainerToggle) {
    logger.info('Adversary pursuit: auto-enabled from prompt/narrative language (toggle was off)');
  }

  const adversaryBehaviors = (input.typeSpec.adversary_behaviors as string[]) || [];
  if (adversaryBehaviors.length === 0 && !promptDetected) return null;

  onProgress?.('Generating adversary pursuit decision tree...');

  const { scenario_type, setting, terrain, venue_name, location } = input;
  const venue = venue_name || location || setting;
  const durationMinutes = input.duration_minutes ?? 60;

  const pursuitTeams = teamNames.filter((t) => {
    const lower = t.toLowerCase();
    return (
      lower.includes('police') ||
      lower.includes('armed') ||
      lower.includes('swat') ||
      lower.includes('soc') ||
      lower.includes('tactical') ||
      lower.includes('intelligence') ||
      lower.includes('intel') ||
      lower.includes('security') ||
      lower.includes('close_protection') ||
      lower.includes('investigation')
    );
  });
  const primaryPursuitTeam =
    pursuitTeams[0] || teamNames.find((t) => /police/i.test(t)) || teamNames[0];
  const intelTeam = teamNames.find((t) => /intel/i.test(t)) || primaryPursuitTeam;
  const triageTeam = teamNames.find((t) => /triage|medical|ems/i.test(t));

  const locationList = locations
    .filter((l) => l.pin_category !== 'route')
    .map(
      (l) =>
        `- ${l.label} (${l.location_type}${l.pin_category ? ', ' + l.pin_category : ''}) at [${l.coordinates.lat}, ${l.coordinates.lng}]`,
    )
    .join('\n');

  const narrativeBlock = narrative
    ? `\nNARRATIVE: ${narrative.title || ''} — ${narrative.description || ''}`
    : '';

  const adversaryCount = input.threat_profile?.adversary_count ?? 1;
  const weaponType = input.threat_profile?.weapon_type || 'unknown';
  const multiAdversary = adversaryCount > 1;

  const systemPrompt = `You are an expert crisis simulation designer building an ADVERSARY PURSUIT DECISION TREE for a tabletop exercise. The pursuit is NOT real-time movement — it is a branching narrative of decision points that test the command team's shot-calling ability.

Scenario: ${scenario_type} at ${venue}
Setting: ${setting} | Terrain: ${terrain}
Teams: ${teamNames.join(', ')}
Primary pursuit team: ${primaryPursuitTeam}
Intelligence team: ${intelTeam}
${triageTeam ? `Triage team: ${triageTeam}` : ''}
Game duration: ${durationMinutes} minutes
Adversary behaviors: ${adversaryBehaviors.join(', ')}
Weapon: ${weaponType}
Number of adversaries: ${adversaryCount}
${narrativeBlock}

AVAILABLE LOCATIONS (use ONLY these coordinates — do NOT invent new ones):
${locationList}

HOW THE PURSUIT WORKS:
- The adversary is NOT a moving pin. Players never see the adversary's real-time position.
- Instead, players receive SIGHTING REPORTS as injects from MULTIPLE INTELLIGENCE SOURCES, and a "last known position" marker updates on the map with a confidence-based accuracy radius.
- At key moments, the pursuit team receives DECISION POINT injects with 2-3 options.
- Each option leads to different consequences — some branch into new decision points.
- The pursuit runs ALONGSIDE the emergency response — pursuit decisions can impact other teams (e.g. pulling officers from a cordon).
${
  multiAdversary
    ? `
MULTIPLE ADVERSARIES (${adversaryCount}):
- Generate ${adversaryCount} DISTINCT adversary profiles, each with unique adversary_id (adversary_1, adversary_2, etc.), distinct behavior_profiles, distinct initial_zones, and different escape vectors.
- Each adversary should have their own pursuit injects with their adversary_id in the adversary_sighting.
- WITNESS CONFUSION: Some eyewitness reports should be ambiguous about WHICH suspect they saw. Some witnesses conflate two suspects into one. Some witnesses attribute Suspect 1's actions to Suspect 2. This forces the command team to maintain separate tracking boards and cross-reference carefully.
- Each adversary gets their own initial_last_known entry.
- Pursuit gates apply to ALL adversaries — "suspect_neutralised" means ALL suspects accounted for.`
    : ''
}

INTELLIGENCE SOURCES — choose sources that REALISTICALLY EXIST at this venue and locale.
Consider what surveillance, communication, and tracking infrastructure is available:
- Urban areas may have CCTV networks, ANPR, cell tower density, traffic cameras
- Rural areas may rely on eyewitnesses, forestry/wildlife cameras, aerial observation, ranger patrols
- Venues may have private security cameras, access control logs, parking systems, turnstile data
- Law enforcement capabilities depend on the jurisdiction — not every locale has helicopter units, K9 teams, or advanced surveillance

Each sighting inject MUST specify:
- intel_source: a descriptive string of the actual source (e.g. "shopping_centre_cctv", "toll_booth_anpr", "park_ranger_eyewitness", "police_helicopter_thermal", "metro_transit_camera", "atm_camera", "doorbell_camera")
- confidence: "high" | "medium" | "low" based on source reliability and precision
- accuracy_radius_m: realistic radius based on the source type (camera footage: 30-100m, phone triangulation: 200-500m, eyewitness: 300-800m, K9 scent trail: 100-200m)

Use at least 4 distinct source types. Mix confidence levels to force players to weigh conflicting intel.

WHAT TO GENERATE:

1. ADVERSARY PROFILE${multiAdversary ? 'S' : ''}: ${multiAdversary ? `${adversaryCount} distinct adversaries, each with unique IDs, behavior profiles, and initial zones.` : 'A single adversary with behavior matching the scenario.'}

2. PURSUIT TIME INJECTS (8-12 injects): Delivered at fixed times. EACH sighting inject uses a DIFFERENT intel_source. You MUST use at least 4 distinct intel_source types across all injects. Intel sources are graded by NATO Admiralty reliability — use this to create tension:
   - A (completely reliable): body_camera, dash_camera
   - B (usually reliable): cctv_operator, facial_recognition, license_plate_reader, aerial_unit, helicopter_thermal
   - C (fairly reliable): tracking_team, forensic_team, radio_intercept, k9_tracking, cell_tower
   - D (not usually reliable): security_guard, store_clerk, taxi_driver, hospital_alert, informant
   - E (unreliable): anonymous_caller, social_media, bystander, eyewitness
   Mix high/medium/low confidence sources. Use the exact snake_case intel_source values above. Each sighting inject must include an "adversary_sighting" in state_effect with intel_source, confidence, accuracy_radius_m, and optional direction_of_travel.

3. FALSE LEAD INJECTS (2-3 injects within pursuit_time_injects): Mark these with "is_false_lead": true in the adversary_sighting. These are reports that turn out to be WRONG — similar-looking individual, a lookalike captured on camera, a cloned or misread number plate, or a civilian matching the description at a hospital. FALSE LEADS CAN COME FROM ANY CONFIDENCE LEVEL — in fact, at least one MUST be high-confidence (e.g. clear camera footage of the wrong person) because those are the most tactically dangerous: commanders will commit heavy resources based on precise-but-wrong intel. The content should be plausible and the location should draw resources AWAY from the actual pursuit corridor. A new map pin will appear at the false location (players don't know it's false until a later inject reveals it).
   DEBUNK INJECTS: For EACH false lead, include a follow-up inject later in pursuit_time_injects that reveals it was wrong. On the debunk inject, add "debunks_inject_index": N in the root of the inject object (NOT inside state_effect), where N is the 0-based index of the false-lead inject within the pursuit_time_injects array. The debunk inject should NOT have an adversary_sighting in state_effect. Its content should explain how the false lead was discovered (e.g. "CCTV review confirms the individual at Car Park B was a maintenance worker — NOT the suspect").

4. PURSUIT CONDITION INJECTS (3-5 injects): Branches that fire based on which decisions the pursuit team made. Use trigger_condition with keywords matching the prior decision.

5. RESOURCE-GATED INJECTS (2-3 injects within pursuit_time_injects): These are higher-quality intel that should narratively explain WHY better intel is available — e.g. an operator reviewing the camera network, a specialist tracking team deployed, or an aerial asset on station. The content should hint that deploying a specific player asset improves intel quality.
   Mark these with "resource_hint" in the adversary_sighting — use a descriptive string matching the resource type (e.g. "cctv_operator", "tracking_team", "aerial_unit", "forensic_team").

6. WITNESS INJECTS (1-3 injects): Reports from injured civilians that go to the triage team ONLY. These contain pursuit-relevant intel that the triage team must relay to the police team via a decision.

7. CONTAINMENT TEST INJECTS (1-2 injects within pursuit_time_injects): These describe the suspect approaching or testing a perimeter/cordon area. The content should say something like "Suspect seen approaching the intersection of X and Y" — a location where players SHOULD have placed a cordon. Mark with "tests_containment": true in the adversary_sighting. If players have cordons there, the system will auto-generate a "suspect turned back" follow-up. If not, the suspect breaks through.

8. PURSUIT GATES (3 gates):
   - "suspect_localised" (check at ~${Math.round(durationMinutes * 0.25)} min)
   - "perimeter_established" (check at ~${Math.round(durationMinutes * 0.5)} min)
   - "suspect_neutralised" (check at ~${Math.round(durationMinutes * 0.8)} min)

9. CASUALTY-SPAWNING INJECTS: 1-2 time-based injects that spawn additional casualties if the adversary is still active. Include conditions_to_cancel: ["gate_met:suspect_neutralised"].

Return ONLY valid JSON:
{
  "adversary_profiles": [
    {
      "adversary_id": "adversary_1",
      "adversary_type": "string",
      "label": "string (e.g. 'Unidentified Male Gunman')",
      "behavior_profile": "aggressive_roamer|escape_oriented|barricader|hunter",
      "weapon_type": "string",
      "initial_zone": "string (zone label from AVAILABLE LOCATIONS)"
    }${multiAdversary ? ` // ... generate ${adversaryCount} profiles total, each with unique adversary_id, behavior, and initial_zone` : ''}
  ],
  "pursuit_time_injects": [
    {
      "trigger_time_minutes": number,
      "type": "intel_brief|field_update|citizen_call",
      "title": "string",
      "content": "string (2-4 sentences — always specify the intel source naturally in the narrative, e.g. 'CCTV at Junction 3 captured...' or 'Eyewitness reports a male matching...')",
      "severity": "critical|high|medium",
      "inject_scope": "team_specific",
      "target_teams": ["${primaryPursuitTeam}"],
      "requires_response": true,
      "state_effect": {
        "adversary_sighting": {
          "adversary_id": "string",
          "lat": number (from AVAILABLE LOCATIONS),
          "lng": number (from AVAILABLE LOCATIONS),
          "zone_label": "string",
          "description": "string",
          "intel_source": "string (descriptive source that realistically exists at this venue)",
          "confidence": "high|medium|low",
          "accuracy_radius_m": number (realistic for the source type),
          "direction_of_travel": "string or null (e.g. 'northeast toward Block 7', null if unknown)",
          "is_false_lead": false,
          "resource_hint": "string or null (descriptive resource type, e.g. 'cctv_operator', 'tracking_team', 'aerial_unit')",
          "tests_containment": false
        }
      }
    }
  ],
  "pursuit_condition_injects": [
    {
      "type": "intel_brief|field_update",
      "title": "string",
      "content": "string",
      "severity": "critical|high|medium",
      "inject_scope": "team_specific",
      "target_teams": ["${primaryPursuitTeam}"],
      "requires_response": true,
      "trigger_condition": {
        "type": "decision_based",
        "match_criteria": { "keywords": ["keyword1", "keyword2"] },
        "match_mode": "any"
      },
      "state_effect": {
        "adversary_sighting": {
          "adversary_id": "string",
          "lat": number,
          "lng": number,
          "zone_label": "string",
          "description": "string",
          "intel_source": "string",
          "confidence": "high|medium|low",
          "accuracy_radius_m": number,
          "direction_of_travel": "string or null",
          "is_false_lead": false,
          "resource_hint": null,
          "tests_containment": false
        }
      }
    }
  ],
  "witness_injects": [
    {
      "trigger_time_minutes": number,
      "type": "citizen_call",
      "title": "string",
      "content": "string (witness account from injured person — contains pursuit intel)",
      "severity": "medium|high",
      "inject_scope": "team_specific",
      "target_teams": ["${triageTeam || primaryPursuitTeam}"],
      "requires_response": false
    }
  ],
  "casualty_spawning_injects": [
    {
      "trigger_time_minutes": number,
      "type": "field_update",
      "title": "string",
      "content": "string",
      "severity": "critical",
      "inject_scope": "universal",
      "target_teams": [],
      "requires_response": true,
      "conditions_to_cancel": ["gate_met:suspect_neutralised"],
      "state_effect": {
        "adversary_casualties": {
          "count": number,
          "zone_label": "string (from AVAILABLE LOCATIONS)",
          "coordinates": { "lat": number, "lng": number },
          "casualty_type": "patient",
          "severity_distribution": { "red": number, "yellow": number, "green": number }
        }
      }
    }
  ],
  "pursuit_gates": [
    {
      "gate_id": "suspect_localised|perimeter_established|suspect_neutralised",
      "gate_order": number,
      "check_at_minutes": number,
      "condition": {
        "team": "${primaryPursuitTeam}",
        "content_hints": ["keyword1", "keyword2"],
        "min_hints": 1
      }
    }
  ],
  "initial_last_known": [
    {
      "adversary_id": "adversary_1",
      "lat": number (from AVAILABLE LOCATIONS — where adversary was first seen),
      "lng": number,
      "zone_label": "string"
    }${multiAdversary ? ` // ... one entry per adversary` : ''}
  ]
}

RULES:
- All coordinates MUST come from the AVAILABLE LOCATIONS list. Do NOT invent coordinates.
- Pursuit injects must create genuine decision tension — each option should have real tradeoffs.
- At least 2 pursuit decisions must impact OTHER teams (e.g. pulling resources, weakening cordons).
- Witness injects go to the triage team. They contain intel that is ONLY useful if relayed.
- Casualty-spawning injects simulate the adversary continuing to cause harm while not neutralised.
- The pursuit arc should follow: initial sighting → localisation decisions → containment → intercept/resolution.
- Gate content_hints should match likely decision keywords (e.g. "camera", "cordon", "sweep", "breach", "apprehend").
- Use at LEAST 4 different intel_source types across all pursuit_time_injects and pursuit_condition_injects. Choose sources that realistically exist at this venue.
- CRITICAL: "high confidence" means the SOURCE is reliable and the LOCATION is precise — it does NOT mean the identification is correct. A camera can clearly capture a lookalike. A number plate reader can flag a cloned plate. An aerial thermal can lock onto the wrong person. High-confidence false leads are the MOST dangerous because commanders commit heavy resources to them. At least ONE false lead MUST come from a high-confidence source to test whether players blindly trust precise intel without cross-referencing.
- Resource-gated injects should naturally reference the resource in the narrative (e.g. "Tracking team reports trail heading east" or "Camera operator identifies movement on screen 7").
- Containment test injects should target locations where a competent team would logically place cordons.
- Direction of travel should be included on visual surveillance and tracking sources. Omit for phone triangulation, financial, and social media sources.
- The overall intel flow should create a realistic "fog of war" — early reports are low confidence, later reports improve as resources are deployed.
- ANTI-PATTERN RULE: Do NOT create a predictable relationship between confidence level and correctness. Correct intel MUST appear across ALL confidence tiers — some low-confidence eyewitness reports should be accurate, some high-confidence CCTV should be wrong. The player must NEVER be able to deduce correctness from source type or confidence level alone. They must cross-reference MULTIPLE independent reports to triangulate the truth. Vary the pattern — never make "latest high-confidence report = always correct."
- RANDOMISATION RULE: Across the 8-12 pursuit injects, the TRUE pursuit corridor should be supported by a MIX of high, medium, AND low confidence sources. Similarly, false leads should come from a MIX of confidence levels. A correct low-confidence eyewitness report followed by a wrong high-confidence CCTV report is a realistic and valuable training scenario. The goal is to teach players that NO single source is gospel — only corroboration across independent sources builds a reliable picture.`;

  const userPrompt = `Generate the adversary pursuit decision tree for "${narrative?.title || scenario_type}" at ${venue}. Adversary behaviors: ${adversaryBehaviors.join(', ')}. Duration: ${durationMinutes} minutes. Make the decisions genuinely difficult with realistic tradeoffs.`;

  try {
    const tokenLimit = multiAdversary ? 8000 + (adversaryCount - 1) * 2000 : 8000;
    const parsed = await callOpenAi<{
      adversary_profile?: {
        adversary_id?: string;
        adversary_type?: string;
        label?: string;
        behavior_profile?: string;
        weapon_type?: string;
        initial_zone?: string;
      };
      adversary_profiles?: Array<{
        adversary_id?: string;
        adversary_type?: string;
        label?: string;
        behavior_profile?: string;
        weapon_type?: string;
        initial_zone?: string;
      }>;
      pursuit_time_injects?: Array<Record<string, unknown>>;
      pursuit_condition_injects?: Array<Record<string, unknown>>;
      witness_injects?: Array<Record<string, unknown>>;
      casualty_spawning_injects?: Array<Record<string, unknown>>;
      pursuit_gates?: Array<{
        gate_id?: string;
        gate_order?: number;
        check_at_minutes?: number;
        condition?: Record<string, unknown>;
      }>;
      initial_last_known?:
        | { lat?: number; lng?: number; zone_label?: string; adversary_id?: string }
        | Array<{ lat?: number; lng?: number; zone_label?: string; adversary_id?: string }>;
    }>(systemPrompt, userPrompt, openAiApiKey, tokenLimit, 0.8);

    const rawProfiles =
      parsed.adversary_profiles || (parsed.adversary_profile ? [parsed.adversary_profile] : []);
    if (rawProfiles.length === 0 || !rawProfiles[0]?.adversary_id) {
      logger.warn('Adversary pursuit tree: AI returned no adversary profiles');
      return null;
    }

    const adversaryProfiles: AdversaryProfile[] = rawProfiles.map((profile, idx) => ({
      adversary_id: profile.adversary_id || `adversary_${idx + 1}`,
      adversary_type: profile.adversary_type || scenario_type,
      label: profile.label || `Unidentified Suspect ${idx + 1}`,
      behavior_profile: profile.behavior_profile || 'escape_oriented',
      weapon_type: profile.weapon_type || weaponType,
      initial_zone: profile.initial_zone || locations[idx % locations.length]?.label || 'Unknown',
      status: 'active',
      pursuit_phase_gates: ['suspect_localised', 'perimeter_established', 'suspect_neutralised'],
    }));

    const pursuitTimeInjects = (parsed.pursuit_time_injects || []).map((inj) => ({
      trigger_time_minutes: (inj.trigger_time_minutes as number) ?? 3,
      type: normalizeInjectType((inj.type as string) || 'intel_brief'),
      title: (inj.title as string) || 'Pursuit update',
      content: (inj.content as string) || '',
      severity: (inj.severity as string) || 'high',
      inject_scope: 'team_specific' as const,
      target_teams: (inj.target_teams as string[]) || [primaryPursuitTeam],
      requires_response: (inj.requires_response as boolean) ?? true,
      requires_coordination: false,
      state_effect: inj.state_effect as Record<string, unknown> | undefined,
      debunks_inject_index:
        typeof inj.debunks_inject_index === 'number'
          ? (inj.debunks_inject_index as number)
          : undefined,
    }));

    const witnessInjects = (parsed.witness_injects || []).map((inj) => ({
      trigger_time_minutes: (inj.trigger_time_minutes as number) ?? 5,
      type: normalizeInjectType((inj.type as string) || 'citizen_call'),
      title: (inj.title as string) || 'Witness report',
      content: (inj.content as string) || '',
      severity: (inj.severity as string) || 'medium',
      inject_scope: 'team_specific' as const,
      target_teams: (inj.target_teams as string[]) || [triageTeam || primaryPursuitTeam],
      requires_response: false,
      requires_coordination: false,
    }));

    const casualtyInjects = (parsed.casualty_spawning_injects || []).map((inj) => ({
      trigger_time_minutes: (inj.trigger_time_minutes as number) ?? 10,
      type: normalizeInjectType((inj.type as string) || 'field_update'),
      title: (inj.title as string) || 'Additional casualties reported',
      content: (inj.content as string) || '',
      severity: (inj.severity as string) || 'critical',
      inject_scope: 'universal' as const,
      target_teams: [] as string[],
      requires_response: true,
      requires_coordination: false,
      conditions_to_cancel: (inj.conditions_to_cancel as string[]) || [
        'gate_met:suspect_neutralised',
      ],
      state_effect: inj.state_effect as Record<string, unknown> | undefined,
    }));

    const allTimeInjects = [...pursuitTimeInjects, ...witnessInjects, ...casualtyInjects];

    const pursuitCondInjects = (parsed.pursuit_condition_injects || []).map((inj) => ({
      type: normalizeInjectType((inj.type as string) || 'intel_brief'),
      title: (inj.title as string) || 'Pursuit branch',
      content: (inj.content as string) || '',
      severity: (inj.severity as string) || 'high',
      inject_scope: 'team_specific' as const,
      target_teams: (inj.target_teams as string[]) || [primaryPursuitTeam],
      requires_response: (inj.requires_response as boolean) ?? true,
      conditions_to_appear: { threshold: 1, conditions: [] } as {
        threshold?: number;
        conditions?: string[];
      },
      conditions_to_cancel: (inj.conditions_to_cancel as string[]) ?? undefined,
      eligible_after_minutes: (inj.eligible_after_minutes as number) ?? undefined,
      trigger_condition: JSON.stringify(
        inj.trigger_condition || {
          type: 'decision_based',
          match_criteria: { keywords: [] },
          match_mode: 'any',
        },
      ),
      state_effect: inj.state_effect as Record<string, unknown> | undefined,
    }));

    const pursuitGates = (parsed.pursuit_gates || []).map((g, i) => ({
      gate_id: g.gate_id || `pursuit_gate_${i}`,
      gate_order: g.gate_order ?? i + 1,
      check_at_minutes: g.check_at_minutes ?? Math.round(durationMinutes * (0.25 + i * 0.25)),
      condition: {
        team: (g.condition?.team as string) || primaryPursuitTeam,
        decision_types: (g.condition?.decision_types as string[]) || undefined,
        content_hints: (g.condition?.content_hints as string[]) || [],
        min_hints: (g.condition?.min_hints as number) || 1,
      },
    }));

    const rawInitials = Array.isArray(parsed.initial_last_known)
      ? parsed.initial_last_known
      : parsed.initial_last_known
        ? [parsed.initial_last_known]
        : [];

    const lastKnownPins = adversaryProfiles.map((profile, idx) => {
      const initial =
        rawInitials.find((i) => i.adversary_id === profile.adversary_id) ||
        rawInitials[idx] ||
        rawInitials[0];
      const suspectLabel = adversaryProfiles.length > 1 ? ` (Suspect ${idx + 1})` : '';
      return {
        location_type: 'last_known_adversary',
        pin_category: 'last_known_adversary' as const,
        label: `Last Seen: ${initial?.zone_label || profile.initial_zone}${suspectLabel}`,
        coordinates: {
          lat: initial?.lat ?? locations[idx % locations.length]?.coordinates.lat ?? 0,
          lng: initial?.lng ?? locations[idx % locations.length]?.coordinates.lng ?? 0,
        },
        visible_to_teams: [
          primaryPursuitTeam,
          ...(intelTeam !== primaryPursuitTeam ? [intelTeam] : []),
        ],
        conditions: {
          adversary_id: profile.adversary_id,
          zone_label: initial?.zone_label || profile.initial_zone,
          last_seen_at_minutes: 0,
          pin_category: 'last_known_adversary',
        },
      };
    });

    logger.info(
      {
        adversaryCount: adversaryProfiles.length,
        adversaryIds: adversaryProfiles.map((p) => p.adversary_id),
        timeInjects: allTimeInjects.length,
        condInjects: pursuitCondInjects.length,
        gates: pursuitGates.length,
      },
      'Adversary pursuit tree generated',
    );

    return {
      adversary_profiles: adversaryProfiles,
      pursuit_time_injects: allTimeInjects,
      pursuit_condition_injects: pursuitCondInjects as NonNullable<
        WarroomScenarioPayload['condition_driven_injects']
      >,
      pursuit_gates: pursuitGates,
      last_known_pins: lastKnownPins,
    };
  } catch (err) {
    logger.warn({ err }, 'Adversary pursuit tree generation failed; continuing without');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Env inject sub-generators removed — replaced by AI runtime evaluation
// ---------------------------------------------------------------------------
/**
 * Exported alias so warroomService can run Phase 1 before standards research
 * and then pass the result back in via input.phase1Preview.
 */
export const generateTeamsAndCoreForResearch = generateTeamsAndCore;

/**
 * Generate full scenario payload using multi-phase AI.
 *
 * Phase 1      (sequential) : teams + core scenario
 * Batch A      (parallel)   : universal time injects + per-team time injects + per-team decision injects + per-team chaos injects
 * Phase 4a-1   (parallel)   : scenario-fixed pins (anchored to building outline)
 *   + POI enrichment        : (runs in parallel with 4a-1)
 * Phase 4a-2   (sequential) : candidate-space pins (selected from OSM open spaces, after 4a-1)
 * Phase 4b     (sequential) : environmental seeds
 * Phase 4c     (sequential) : layout + site knowledge
 * Phase 4d     (parallel)   : team intelligence dossiers (one call per team)
 * Batch B      (parallel)   : per-team condition injects + per-pair condition injects
 * Post-process              : normalizeInjectTiming + validatePinTopology
 */
export async function warroomGenerateScenario(
  input: WarroomGenerateInput,
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
): Promise<WarroomScenarioPayload> {
  const { osm_vicinity } = input;

  // Phase 1 — teams + core (or use pre-computed result from narrative-first flow)
  const phase1 =
    input.phase1Preview ?? (await generateTeamsAndCore(input, openAiApiKey, onProgress));
  const teamNames = phase1.teams.map((t) => t.team_name);
  const narrative = {
    title: phase1.scenario.title,
    description: phase1.scenario.description,
    briefing: phase1.scenario.briefing,
  };

  // Classify teams as operational vs non-operational for differentiated inject counts
  const durationMinutes = input.duration_minutes ?? 60;
  const teamTypes = await classifyTeamTypes(
    teamNames.map((n) => ({ team_name: n })),
    input.scenario_type,
    openAiApiKey,
  );
  const timingManifest = buildTimingManifest(teamNames, durationMinutes, teamTypes);

  // Batch A — time injects + chaos injects
  // All calls run sequentially so each generator receives the full list of
  // already-generated themes, preventing cross-team and cross-type duplication.
  onProgress?.('Generating injects (batch A)...');

  // --- Deterministic T+0 inject (initial incident report) ---
  const venue = input.venue_name || input.location || input.setting;
  const t0Inject: WarroomScenarioPayload['time_injects'][number] = {
    trigger_time_minutes: 0,
    type: 'field_update',
    title: `INITIAL REPORT: ${narrative.title || input.scenario_type}`,
    content:
      narrative.description ||
      (narrative.briefing || '').slice(0, 300) ||
      `A ${input.scenario_type} has been reported at ${venue}. All teams respond immediately.`,
    severity: 'critical',
    inject_scope: 'universal',
    target_teams: [],
    requires_response: true,
    requires_coordination: false,
  };

  // Universal slots already exclude T+0 (handled by deterministic t0Inject)
  const universalTimeInjects = await generateUniversalTimeInjects(
    input,
    teamNames,
    openAiApiKey,
    timingManifest.universalSlots,
    undefined,
    narrative,
  );

  // Accumulate theme summaries (title + content snippet) for richer dedup
  const allThemes: string[] = [
    `${t0Inject.title}: ${(t0Inject.content || '').slice(0, 80)}`,
    ...universalTimeInjects.map((i) => `${i.title}: ${(i.content || '').slice(0, 80)}`),
  ];

  const perTeamTimeResults: Array<WarroomScenarioPayload['time_injects']> = [];
  for (const t of teamNames) {
    const result = await generateTeamTimeInjects(
      input,
      t,
      teamNames,
      openAiApiKey,
      timingManifest.teamSlots[t] ?? [],
      narrative,
      allThemes,
    );
    perTeamTimeResults.push(result);
    allThemes.push(...result.map((i) => `${i.title}: ${(i.content || '').slice(0, 80)}`));
  }

  const perTeamChaosResults: Array<
    NonNullable<WarroomScenarioPayload['condition_driven_injects']>
  > = [];
  for (const t of teamNames) {
    const result = await generateChaosInjects(
      input,
      t,
      teamNames,
      openAiApiKey,
      timingManifest.teamChaosCount[t] ?? 2,
      narrative,
      allThemes,
    );
    perTeamChaosResults.push(result);
    allThemes.push(...result.map((i) => `${i.title}: ${(i.content || '').slice(0, 80)}`));
  }

  // Merge all time injects: deterministic T+0 first, then AI-generated
  const rawTimeInjects: WarroomScenarioPayload['time_injects'] = [
    t0Inject,
    ...universalTimeInjects,
    ...perTeamTimeResults.flat(),
  ];

  // AI-based semantic dedup: remove injects whose theme overlaps a previous inject
  onProgress?.('Deduplicating injects...');
  const dedupedTimeInjects = await deduplicateInjectsByTheme(rawTimeInjects, openAiApiKey);
  const time_injects = normalizeInjectTiming(dedupedTimeInjects, durationMinutes);

  // Phase 4a-1 (scenario-fixed pins) + POI enrichment run in PARALLEL
  const [scenarioFixedPins, poiPins] = await Promise.all([
    generateScenarioFixedPins(input, teamNames, openAiApiKey, onProgress, narrative),
    osm_vicinity
      ? generatePoiPinsFromOsm(
          osm_vicinity,
          input.scenario_type,
          venue,
          input.geocode ? { lat: input.geocode.lat, lng: input.geocode.lng } : undefined,
          openAiApiKey,
        ).catch((err) => {
          logger.warn({ err }, 'POI pin generation failed; continuing without');
          return [] as NonNullable<WarroomScenarioPayload['locations']>;
        })
      : Promise.resolve([] as NonNullable<WarroomScenarioPayload['locations']>),
  ]);

  // Merge and validate all pins (incident site + entry/exit + POIs)
  const mergedPins: NonNullable<WarroomScenarioPayload['locations']> = [
    ...(scenarioFixedPins ?? []),
    ...poiPins,
  ];
  const locations =
    mergedPins.length > 0
      ? validatePinTopology(
          mergedPins,
          input.geocode ? { lat: input.geocode.lat, lng: input.geocode.lng } : undefined,
          input.osmOpenSpaces,
        )
      : undefined;

  if (poiPins.length > 0) {
    logger.info({ poiCount: poiPins.length }, 'POI pins generated from OSM');
  }

  // Counter definitions first, then environmental seeds (seeds reference counter keys)
  const counterDefsMap = await generateCounterDefinitions(
    input,
    teamNames,
    openAiApiKey,
    onProgress,
    narrative,
  );

  // Route network: compute corridors from OSM data, then AI-enrich with conditions
  if (input.osmRouteGeometries?.length && locations?.length) {
    const incidentPin = locations.find((l) => l.pin_category === 'incident_site');
    const incidentCoords = incidentPin?.coordinates ?? input.geocode;
    if (incidentCoords) {
      const facilityPins = locations.filter((l) => l.pin_category === 'poi');
      const corridors = computeRouteCorridors(
        input.osmRouteGeometries,
        facilityPins.map((p) => ({
          label: p.label,
          coordinates: p.coordinates,
          location_type: p.location_type,
        })),
        incidentCoords,
      );
      if (corridors.length > 0) {
        const routeLocations = await enrichRouteLocations(
          input,
          corridors,
          facilityPins.map((p) => ({
            label: p.label,
            location_type: p.location_type,
            conditions: p.conditions,
          })),
          openAiApiKey,
          onProgress,
          narrative,
        );
        if (routeLocations?.length) {
          locations.push(...routeLocations);
        }
      }
    }
  }

  // Attach counter definitions to teams (AI-generated or template fallback)
  const effectiveDefsMap = counterDefsMap ?? loadTemplateCounterDefs(input.scenario_type);
  if (effectiveDefsMap) {
    for (const team of phase1.teams) {
      const n = team.team_name.toLowerCase();
      const defs =
        effectiveDefsMap[team.team_name] ??
        effectiveDefsMap[n] ??
        Object.entries(effectiveDefsMap).find(([k]) => k.toLowerCase() === n)?.[1];
      if (defs?.length) {
        team.counter_definitions = defs;
      }
    }
  }

  const [phase4c, scenarioHazards] = await Promise.all([
    generateLayoutAndSiteKnowledge(
      input,
      teamNames,
      openAiApiKey,
      onProgress,
      narrative,
      locations,
    ),
    generateScenarioHazards(input, openAiApiKey, onProgress, narrative, locations, teamNames),
  ]);
  const floorPlansResult = undefined;

  // Generate unified incident zones (one hot/warm/cold set for the whole incident)
  let unifiedZones: ZoneWithPolygon[] = [];
  if (scenarioHazards?.length) {
    unifiedZones = await generateUnifiedIncidentZones(
      input,
      scenarioHazards,
      openAiApiKey,
      teamNames,
      onProgress,
    );
    // Store zones on the first hazard only; others get empty arrays
    if (unifiedZones.length > 0) {
      scenarioHazards[0].zones = unifiedZones;
      for (let i = 1; i < scenarioHazards.length; i++) {
        scenarioHazards[i].zones = [];
      }
    }
  }

  // Build a zone summary block for casualty/crowd generation prompts
  const zoneSummaryBlock =
    unifiedZones.length > 0
      ? `\nUNIFIED INCIDENT ZONES (use these for pin placement):
${unifiedZones.map((z) => `- ${z.zone_type.toUpperCase()} zone: radius ${z.radius_m}m from incident center. ${z.activities.join(', ')}. Allowed teams: ${z.allowed_teams.join(', ')}`).join('\n')}`
      : '';

  // Casualty + crowd generation (casualties depend on hazard data + zone info for positioning)
  const [casualtyPins, crowdPins, convergentResult] = await Promise.all([
    generateCasualties(
      input,
      openAiApiKey,
      onProgress,
      narrative,
      locations,
      scenarioHazards,
      zoneSummaryBlock,
    ),
    generateCrowdPins(input, openAiApiKey, onProgress, narrative, locations, zoneSummaryBlock),
    generateConvergentCrowds(input, openAiApiKey, onProgress, narrative, locations, teamNames),
  ]);
  const convergentPins = convergentResult?.crowds;
  const convergentAlertInjects = convergentResult?.alertInjects;
  const allCasualtyPins = [
    ...(casualtyPins ?? []),
    ...(crowdPins ?? []),
    ...(convergentPins ?? []),
  ];
  const casualties: WarroomScenarioPayload['casualties'] =
    allCasualtyPins.length > 0 ? allCasualtyPins : undefined;

  // Reconcile counter pool caps with actual pin counts so UI totals match reality
  if (allCasualtyPins.length > 0) {
    let totalPatients = 0;
    let totalEvacuees = 0;
    for (const pin of allCasualtyPins) {
      const hc = pin.headcount ?? 1;
      if (pin.casualty_type === 'patient') {
        totalPatients += hc;
      } else {
        totalEvacuees += hc;
      }
    }
    for (const team of phase1.teams) {
      if (!team.counter_definitions?.length) continue;
      for (const def of team.counter_definitions) {
        if (def.key === 'total_patients' && def.behavior === 'static' && totalPatients > 0) {
          def.initial_value = totalPatients;
        }
        if (def.key === 'total_evacuees' && def.behavior === 'static' && totalEvacuees > 0) {
          def.initial_value = totalEvacuees;
        }
      }
    }
    logger.info(
      { totalPatients, totalEvacuees, pinCount: allCasualtyPins.length },
      'Counter pool caps reconciled with actual pin counts',
    );
  }

  // Equipment palette derived from hazard + casualty requirements
  const scenarioEquipment = await generateScenarioEquipment(scenarioHazards, casualties, teamNames);

  // Phase 4d — Team Intelligence Dossiers (one AI call per team, in parallel)
  const teamDossiers = await generateTeamIntelligenceDossiers(
    input,
    teamNames,
    phase1.teams,
    openAiApiKey,
    onProgress,
    narrative,
    locations,
    phase4c,
  );

  const scenarioWithType = {
    ...phase1.scenario,
    initial_state: {
      ...phase1.scenario.initial_state,
      scenario_type: input.scenario_type,
    },
  };

  const insiderKnowledge: WarroomScenarioPayload['insider_knowledge'] = {};
  if (osm_vicinity) insiderKnowledge.osm_vicinity = osm_vicinity;
  if (
    input.researchContext?.standards_findings &&
    input.researchContext.standards_findings.length > 0
  ) {
    insiderKnowledge.sector_standards_structured = input.researchContext.standards_findings;
    insiderKnowledge.sector_standards = standardsToPromptBlock(
      input.researchContext.standards_findings,
    );
  }

  if (
    input.researchContext?.team_doctrines &&
    Object.keys(input.researchContext.team_doctrines).length > 0
  ) {
    insiderKnowledge.team_doctrines = input.researchContext.team_doctrines;
  } else if (!insiderKnowledge.sector_standards && input.researchContext?.standards_summary) {
    insiderKnowledge.sector_standards = input.researchContext.standards_summary;
  }
  if (phase4c.layout_ground_truth)
    insiderKnowledge.layout_ground_truth = phase4c.layout_ground_truth;
  if (phase4c.site_areas?.length) insiderKnowledge.site_areas = phase4c.site_areas;
  if (phase4c.custom_facts?.length) insiderKnowledge.custom_facts = phase4c.custom_facts;
  if (phase4c.baseline_escalation_factors?.length) {
    insiderKnowledge.baseline_escalation_factors = phase4c.baseline_escalation_factors;
  }
  if (teamDossiers && Object.keys(teamDossiers).length > 0) {
    insiderKnowledge.team_intelligence_dossiers = teamDossiers;
  }

  // Team workflow chains (endgame, steps, ratios, SOP)
  try {
    onProgress?.('Researching team workflow chains...');
    const workflows = await researchTeamWorkflows(
      openAiApiKey,
      input.scenario_type,
      teamNames,
      narrative,
    );
    if (Object.keys(workflows).length > 0) {
      insiderKnowledge.team_workflows = workflows;
    }
  } catch (err) {
    logger.warn({ err }, 'Team workflow research failed; continuing without');
  }

  const hasInsiderKnowledge = Object.keys(insiderKnowledge).length > 0;

  const allConditionInjects = await deduplicateConditionInjectsByTheme(
    perTeamChaosResults.flat(),
    time_injects,
    openAiApiKey,
  );
  const condition_driven_injects = allConditionInjects.length > 0 ? allConditionInjects : undefined;

  const finalTimeInjects = convergentAlertInjects?.length
    ? [...time_injects, ...convergentAlertInjects].sort(
        (a, b) => (a.trigger_time_minutes ?? 0) - (b.trigger_time_minutes ?? 0),
      )
    : time_injects;

  return {
    scenario: scenarioWithType,
    teams: phase1.teams,
    objectives: phase1.objectives,
    time_injects: finalTimeInjects,
    condition_driven_injects,
    locations,
    hazards: scenarioHazards,
    casualties,
    equipment: scenarioEquipment,
    floor_plans: floorPlansResult,
    insider_knowledge: hasInsiderKnowledge ? insiderKnowledge : undefined,
  };
}
