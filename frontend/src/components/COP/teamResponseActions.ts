export interface TeamAction {
  id: string;
  label: string;
  description: string;
  icon: string;
  keywords: string[];
  requiresElement?: ('hazard' | 'casualty' | 'crowd' | 'entry_exit')[];
}

const POLICE_ACTIONS: TeamAction[] = [
  {
    id: 'establish_perimeter',
    label: 'Establish Perimeter',
    description: 'Set up an outer cordon to secure the area and control access.',
    icon: 'barrier',
    keywords: ['perimeter', 'cordon', 'secure', 'contain'],
  },
  {
    id: 'room_clearance',
    label: 'Initiate Room Clearance',
    description: 'Begin systematic room-by-room search and clearance.',
    icon: 'search',
    keywords: ['clear', 'sweep', 'room', 'advance', 'breach', 'entry'],
  },
  {
    id: 'deploy_tactical',
    label: 'Deploy Tactical Unit',
    description: 'Send in armed tactical response to neutralize threat.',
    icon: 'tactical_unit',
    keywords: ['tactical', 'armed response', 'swat', 'deploy'],
  },
  {
    id: 'neutralize_threat',
    label: 'Neutralize Threat',
    description: 'Authorize use of force to stop the active threat.',
    icon: 'shield',
    keywords: ['neutralize', 'stop', 'eliminate', 'engage'],
    requiresElement: ['hazard'],
  },
  {
    id: 'secure_area',
    label: 'Secure Area',
    description: 'Lock down and secure the immediate area around the incident.',
    icon: 'shield',
    keywords: ['secure', 'lockdown', 'area', 'clear'],
  },
  {
    id: 'request_backup',
    label: 'Request Armed Backup',
    description: 'Request additional armed units to support operations.',
    icon: 'armored_vehicle',
    keywords: ['backup', 'reinforcement', 'additional', 'support'],
  },
];

const NEGOTIATION_ACTIONS: TeamAction[] = [
  {
    id: 'open_channel',
    label: 'Open Communication Channel',
    description: 'Establish initial contact with the perpetrator.',
    icon: 'negotiation_post',
    keywords: ['contact', 'communicate', 'negotiate', 'call', 'channel'],
  },
  {
    id: 'relay_demands',
    label: 'Relay Demands',
    description: 'Document and relay perpetrator demands to command.',
    icon: 'clipboard',
    keywords: ['demands', 'relay', 'ransom', 'requirements'],
  },
  {
    id: 'propose_exchange',
    label: 'Propose Exchange',
    description: 'Offer exchange or compromise to secure hostage release.',
    icon: 'handshake',
    keywords: ['exchange', 'propose', 'offer', 'compromise', 'release'],
  },
  {
    id: 'stall_for_time',
    label: 'Stall for Time',
    description: 'Use negotiation tactics to delay and buy time for tactical positioning.',
    icon: 'radio',
    keywords: ['stall', 'delay', 'time', 'patience', 'continue'],
  },
  {
    id: 'proof_of_life',
    label: 'Request Proof of Life',
    description: 'Demand evidence that hostages are alive and unharmed.',
    icon: 'heartbeat',
    keywords: ['proof', 'life', 'alive', 'status', 'welfare'],
  },
];

const INTELLIGENCE_ACTIONS: TeamAction[] = [
  {
    id: 'deploy_surveillance',
    label: 'Deploy Surveillance',
    description: 'Set up surveillance assets to monitor the target area.',
    icon: 'eye',
    keywords: ['surveillance', 'monitor', 'observe', 'watch', 'recon'],
  },
  {
    id: 'aerial_recon',
    label: 'Request Aerial Recon',
    description: 'Deploy drone or helicopter for overhead reconnaissance.',
    icon: 'drone',
    keywords: ['aerial', 'drone', 'helicopter', 'overhead', 'recon'],
  },
  {
    id: 'background_check',
    label: 'Run Background Check',
    description: 'Research perpetrator identity, associates, and history.',
    icon: 'intel_hub',
    keywords: ['background', 'check', 'identity', 'research', 'profile'],
  },
  {
    id: 'establish_listening',
    label: 'Establish Listening Post',
    description: 'Set up communications intercept to gather intelligence.',
    icon: 'listening_post',
    keywords: ['listen', 'intercept', 'intel', 'intelligence', 'comms'],
  },
  {
    id: 'share_intel',
    label: 'Share Intel Brief',
    description: 'Distribute intelligence findings to operational teams.',
    icon: 'clipboard',
    keywords: ['share', 'brief', 'distribute', 'intelligence', 'update'],
  },
];

const CLOSE_PROTECTION_ACTIONS: TeamAction[] = [
  {
    id: 'vip_extraction',
    label: 'Initiate VIP Extraction',
    description: 'Begin immediate extraction of the VIP to a secure location.',
    icon: 'vip_extract',
    keywords: ['extract', 'evacuate VIP', 'move VIP', 'remove'],
  },
  {
    id: 'establish_safe_room',
    label: 'Establish Safe Room',
    description: 'Secure and fortify a location as a safe room for the VIP.',
    icon: 'safe_room',
    keywords: ['safe room', 'shelter', 'holding area', 'secure location'],
  },
  {
    id: 'deploy_protection',
    label: 'Deploy Protection Detail',
    description: 'Position close protection officers around the VIP.',
    icon: 'protection_detail',
    keywords: ['detail', 'bodyguard', 'protection', 'close protection'],
  },
  {
    id: 'secure_extraction_route',
    label: 'Secure Extraction Route',
    description: 'Clear and secure the route from the VIP location to the extraction point.',
    icon: 'route',
    keywords: ['route', 'extraction', 'path', 'clear', 'secure'],
  },
];

const EVENT_SECURITY_ACTIONS: TeamAction[] = [
  {
    id: 'lockdown_venue',
    label: 'Lock Down Venue',
    description: 'Seal all entry and exit points. No one in or out.',
    icon: 'checkpoint',
    keywords: ['lockdown', 'seal', 'close gates', 'lock', 'secure'],
  },
  {
    id: 'cctv_sweep',
    label: 'Activate CCTV Sweep',
    description: 'Initiate systematic review of all CCTV feeds for suspect identification.',
    icon: 'cctv',
    keywords: ['cctv', 'camera', 'footage', 'review', 'sweep'],
  },
  {
    id: 'deploy_stewards',
    label: 'Deploy Stewards',
    description: 'Position stewards at key points to guide crowd movement.',
    icon: 'steward',
    keywords: ['steward', 'marshal', 'guide', 'usher', 'deploy'],
  },
  {
    id: 'close_gates',
    label: 'Close Gates',
    description: 'Close specific entry gates to control crowd flow.',
    icon: 'barrier',
    keywords: ['gate', 'close', 'shut', 'entrance', 'control'],
  },
  {
    id: 'enable_pa',
    label: 'Enable PA System',
    description: 'Activate the venue PA system for crowd announcements.',
    icon: 'pa_system',
    keywords: ['PA', 'announce', 'public address', 'loudspeaker', 'broadcast'],
  },
  {
    id: 'secondary_sweep',
    label: 'Secondary Device Sweep',
    description: 'Search venue for secondary threats or suspicious packages.',
    icon: 'search_point',
    keywords: ['sweep', 'secondary', 'device', 'bomb', 'search', 'suspicious'],
  },
];

const CROWD_MANAGEMENT_ACTIONS: TeamAction[] = [
  {
    id: 'open_emergency_gates',
    label: 'Open Emergency Gates',
    description: 'Open emergency exits and barrier gates to relieve crowd pressure.',
    icon: 'barrier',
    keywords: ['open', 'barrier', 'remove', 'gate', 'fence', 'emergency'],
  },
  {
    id: 'reverse_flow',
    label: 'Reverse Crowd Flow',
    description: 'Redirect crowd movement direction to alleviate congestion.',
    icon: 'crowd',
    keywords: ['reverse', 'redirect', 'reroute', 'alternative', 'counter-flow'],
    requiresElement: ['crowd'],
  },
  {
    id: 'deploy_crush_barriers',
    label: 'Deploy Crush Barriers',
    description: 'Place crush barriers to break up dangerous crowd density.',
    icon: 'crush_barrier',
    keywords: ['crush barrier', 'barrier', 'deploy', 'density', 'break up'],
    requiresElement: ['crowd'],
  },
  {
    id: 'stop_ingress',
    label: 'Stop Ingress',
    description: 'Halt all further entry to the venue immediately.',
    icon: 'checkpoint',
    keywords: ['stop entry', 'ingress', 'no more', 'close entrance', 'halt admission'],
  },
  {
    id: 'pa_announcement',
    label: 'Announce via PA',
    description: 'Use PA system to direct crowd behaviour and movement.',
    icon: 'pa_system',
    keywords: ['announce', 'PA', 'loudspeaker', 'broadcast', 'public address'],
  },
  {
    id: 'monitor_density',
    label: 'Monitor Crowd Density',
    description: 'Activate density monitoring at key chokepoints.',
    icon: 'capacity_monitor',
    keywords: ['monitor', 'density', 'count', 'capacity', 'headcount'],
  },
];

const TRANSIT_SECURITY_ACTIONS: TeamAction[] = [
  {
    id: 'halt_service',
    label: 'Halt Service',
    description: 'Stop all transit service through the affected area.',
    icon: 'service_control',
    keywords: ['halt', 'stop', 'suspend', 'service', 'trains'],
  },
  {
    id: 'lock_platform',
    label: 'Lock Platform',
    description: 'Seal off the affected platform from passenger access.',
    icon: 'platform_barrier',
    keywords: ['lock', 'platform', 'seal', 'close', 'restrict'],
  },
  {
    id: 'deploy_marshals',
    label: 'Deploy Platform Marshals',
    description: 'Station marshals at platform edges and stairwells.',
    icon: 'marshal',
    keywords: ['marshal', 'deploy', 'platform', 'station'],
  },
  {
    id: 'emergency_lighting',
    label: 'Activate Emergency Lighting',
    description: 'Switch on emergency lighting throughout the station.',
    icon: 'emergency_light',
    keywords: ['lighting', 'lights', 'illuminate', 'emergency light'],
  },
  {
    id: 'contain_attacker',
    label: 'Contain Attacker',
    description: 'Use station layout to contain and isolate the attacker.',
    icon: 'barrier',
    keywords: ['contain', 'isolate', 'block', 'trap', 'corner'],
  },
];

const EVACUATION_ACTIONS: TeamAction[] = [
  {
    id: 'establish_flow_control',
    label: 'Establish Flow Control',
    description: 'Set up flow management at bottleneck points.',
    icon: 'marshal',
    keywords: ['flow', 'bottleneck', 'stagger', 'egress', 'congestion'],
  },
  {
    id: 'deploy_marshals_evac',
    label: 'Deploy Marshals',
    description: 'Position marshals along evacuation routes to guide civilians.',
    icon: 'marshal',
    keywords: ['marshal', 'steward', 'guide', 'warden', 'usher'],
  },
  {
    id: 'open_alt_routes',
    label: 'Open Alternative Routes',
    description: 'Identify and open secondary evacuation routes.',
    icon: 'door',
    keywords: ['alternative', 'secondary', 'route', 'service entrance', 'back gate'],
  },
  {
    id: 'coordinate_triage',
    label: 'Coordinate with Triage',
    description: 'Establish handover point between evacuation and medical teams.',
    icon: 'medical',
    keywords: ['coordinate', 'triage', 'handover', 'medical'],
  },
];

const TRIAGE_ACTIONS: TeamAction[] = [
  {
    id: 'establish_triage_zone',
    label: 'Establish Triage Zone',
    description: 'Set up a formal triage area with colour-coded treatment zones.',
    icon: 'tent',
    keywords: ['triage zone', 'establish', 'set up', 'treatment area'],
  },
  {
    id: 'request_supplies',
    label: 'Request Medical Supplies',
    description: 'Request additional medical equipment and supplies.',
    icon: 'supply',
    keywords: ['supply', 'request', 'tourniquet', 'stretcher', 'equipment'],
  },
  {
    id: 'warm_zone_entry',
    label: 'Enter Warm Zone',
    description: 'Send medical team into the warm zone for forward triage.',
    icon: 'medical',
    keywords: ['warm zone', 'enter', 'forward triage', 'extraction'],
    requiresElement: ['casualty'],
  },
  {
    id: 'hospital_liaison',
    label: 'Hospital Liaison',
    description: 'Coordinate with receiving hospitals on capacity and specialties.',
    icon: 'radio',
    keywords: ['hospital', 'liaison', 'capacity', 'receiving', 'transfer'],
  },
];

const MEDIA_ACTIONS: TeamAction[] = [
  {
    id: 'issue_statement',
    label: 'Issue Public Statement',
    description: 'Release an official public statement to media.',
    icon: 'podium',
    keywords: ['statement', 'press', 'announce', 'release'],
  },
  {
    id: 'counter_misinfo',
    label: 'Counter Misinformation',
    description: 'Address and correct false information circulating publicly.',
    icon: 'clipboard',
    keywords: ['debunk', 'counter', 'correct', 'misinformation', 'rumour'],
  },
  {
    id: 'reunification_point',
    label: 'Announce Reunification Point',
    description: 'Designate and publicly announce a family reunification location.',
    icon: 'flag',
    keywords: ['reunification', 'family', 'meeting point', 'pickup'],
  },
  {
    id: 'media_blackout',
    label: 'Request Media Blackout',
    description: 'Request media outlets to hold information for operational security.',
    icon: 'camera',
    keywords: ['blackout', 'silence', 'hold', 'embargo', 'restrict'],
  },
  {
    id: 'victim_dignity',
    label: 'Protect Victim Dignity',
    description: 'Ensure victim names are not released before family notification.',
    icon: 'heartbeat',
    keywords: ['no names', 'family first', 'notify family', 'victim dignity'],
  },
];

const FIRE_HAZMAT_ACTIONS: TeamAction[] = [
  {
    id: 'identify_agent',
    label: 'Identify Agent',
    description: 'Test and identify the hazardous substance.',
    icon: 'hazmat',
    keywords: ['identified', 'agent', 'chemical', 'substance', 'detected'],
  },
  {
    id: 'manage_ventilation',
    label: 'Manage Ventilation',
    description: 'Control HVAC and ventilation to contain or disperse the agent.',
    icon: 'water',
    keywords: ['ventilation', 'hvac', 'air flow', 'shut down', 'contain'],
  },
  {
    id: 'establish_hot_zone',
    label: 'Establish Hot Zone',
    description: 'Designate and cordon the contaminated exclusion zone.',
    icon: 'hazmat',
    keywords: ['hot zone', 'exclusion', 'hazard zone', 'cordon'],
    requiresElement: ['hazard'],
  },
  {
    id: 'deploy_decon',
    label: 'Deploy Decontamination',
    description: 'Set up decontamination station for exposed individuals.',
    icon: 'water',
    keywords: ['decontamination', 'decon', 'wash', 'site'],
  },
];

const FIRE_ACTIONS: TeamAction[] = [
  {
    id: 'fire_attack',
    label: 'Initiate Fire Attack',
    description: 'Deploy crews for direct fire suppression.',
    icon: 'firefighter',
    keywords: ['fire attack', 'suppression', 'hose', 'extinguish'],
    requiresElement: ['hazard'],
  },
  {
    id: 'search_rescue',
    label: 'Search & Rescue',
    description: 'Enter structure to locate and extract trapped persons.',
    icon: 'person',
    keywords: ['search', 'rescue', 'trapped', 'victim', 'sweep'],
  },
  {
    id: 'fire_ventilate',
    label: 'Ventilate Structure',
    description: 'Open or cut roof/windows to release heat and smoke.',
    icon: 'water',
    keywords: ['ventilate', 'roof', 'smoke', 'heat release'],
  },
  {
    id: 'structural_assessment',
    label: 'Structural Assessment',
    description: 'Assess building integrity and collapse risk before entry.',
    icon: 'barrier',
    keywords: ['structural', 'collapse', 'integrity', 'assessment'],
  },
  {
    id: 'establish_fire_cordon',
    label: 'Establish Fire Cordon',
    description: 'Cordon the area to prevent public access during operations.',
    icon: 'barrier',
    keywords: ['cordon', 'perimeter', 'exclusion', 'barrier'],
  },
  {
    id: 'water_supply_relay',
    label: 'Water Supply Relay',
    description: 'Establish water relay from hydrant or tanker to scene.',
    icon: 'water',
    keywords: ['water supply', 'hydrant', 'tanker', 'relay'],
  },
];

const BOMB_SQUAD_ACTIONS: TeamAction[] = [
  {
    id: 'render_safe',
    label: 'Render Safe Procedure',
    description: 'Approach and neutralise the suspected device using RSP.',
    icon: 'bomb',
    keywords: ['render safe', 'neutralise', 'disarm', 'rsp'],
    requiresElement: ['hazard'],
  },
  {
    id: 'deploy_robot',
    label: 'Deploy Bomb Robot',
    description: 'Send remote-controlled robot for reconnaissance or disruption.',
    icon: 'bomb_robot',
    keywords: ['robot', 'remote', 'recon', 'eod'],
  },
  {
    id: 'blast_cordon',
    label: 'Set Blast Cordon',
    description: 'Establish the appropriate blast-radius exclusion zone.',
    icon: 'barrier',
    keywords: ['blast', 'cordon', 'exclusion', 'radius', 'standoff'],
  },
  {
    id: 'secondary_sweep',
    label: 'Secondary Device Sweep',
    description: 'Sweep surroundings for additional concealed devices.',
    icon: 'search_point',
    keywords: ['secondary', 'sweep', 'additional', 'concealed'],
  },
  {
    id: 'controlled_detonation',
    label: 'Controlled Detonation',
    description: 'Detonate the device in situ when removal is not viable.',
    icon: 'bomb',
    keywords: ['controlled detonation', 'detonate', 'in situ'],
    requiresElement: ['hazard'],
  },
  {
    id: 'xray_scan',
    label: 'X-Ray Scan',
    description: 'Image a suspicious package to assess internal components.',
    icon: 'xray_scanner',
    keywords: ['xray', 'scan', 'image', 'package'],
  },
];

const MALL_SECURITY_ACTIONS: TeamAction[] = [
  {
    id: 'store_lockdown',
    label: 'Store Lockdown',
    description: 'Direct individual stores to shutter and lock in place.',
    icon: 'barrier',
    keywords: ['lockdown', 'shutter', 'store', 'lock in place'],
  },
  {
    id: 'pa_announcement',
    label: 'PA Announcement',
    description: 'Broadcast evacuation or shelter-in-place instructions.',
    icon: 'pa_system',
    keywords: ['announcement', 'pa', 'broadcast', 'tannoy'],
  },
  {
    id: 'cctv_tracking',
    label: 'CCTV Tracking',
    description: 'Monitor and track suspects via the mall CCTV network.',
    icon: 'cctv',
    keywords: ['cctv', 'camera', 'track', 'monitor', 'suspect'],
  },
  {
    id: 'access_control',
    label: 'Access Point Control',
    description: 'Restrict or channel entry/exit through specific doors.',
    icon: 'checkpoint',
    keywords: ['access', 'entry', 'exit', 'door', 'control'],
    requiresElement: ['entry_exit'],
  },
  {
    id: 'patron_sweep',
    label: 'Patron Floor Sweep',
    description: 'Security teams sweep each floor to guide patrons to exits.',
    icon: 'steward',
    keywords: ['sweep', 'floor', 'patron', 'guide', 'clear'],
  },
  {
    id: 'rendezvous_point',
    label: 'Set Rendezvous Point',
    description: 'Designate external assembly area for evacuated patrons.',
    icon: 'staging',
    keywords: ['rendezvous', 'assembly', 'muster', 'meeting point'],
  },
];

const RESORT_SECURITY_ACTIONS: TeamAction[] = [
  {
    id: 'guest_lockdown',
    label: 'Guest Lockdown',
    description: 'Direct guests to remain in rooms and secure wing access.',
    icon: 'barrier',
    keywords: ['lockdown', 'guest', 'room', 'shelter'],
  },
  {
    id: 'perimeter_patrol',
    label: 'Perimeter Patrol',
    description: 'Deploy patrol units along the resort perimeter and entry points.',
    icon: 'resort_patrol',
    keywords: ['perimeter', 'patrol', 'entry', 'fence'],
  },
  {
    id: 'guest_manifest_check',
    label: 'Guest Manifest Check',
    description: 'Cross-reference guest list to identify missing or unaccounted persons.',
    icon: 'person',
    keywords: ['manifest', 'guest list', 'unaccounted', 'headcount'],
  },
  {
    id: 'vip_relocation',
    label: 'VIP Relocation',
    description: 'Move high-profile guests to a secure area or extraction point.',
    icon: 'vip_extract',
    keywords: ['vip', 'relocate', 'extraction', 'secure', 'high profile'],
  },
  {
    id: 'beach_water_closure',
    label: 'Beach / Water Closure',
    description: 'Close beach access and recall water activity participants.',
    icon: 'beach_patrol',
    keywords: ['beach', 'water', 'close', 'recall', 'lifeguard'],
  },
];

const PUBLIC_HEALTH_ACTIONS: TeamAction[] = [
  {
    id: 'epi_investigation',
    label: 'Epidemiological Investigation',
    description: 'Map the exposure timeline, vector, and affected population.',
    icon: 'biohazard_suit',
    keywords: ['epidemiological', 'investigation', 'exposure', 'vector', 'mapping'],
  },
  {
    id: 'hospital_surge',
    label: 'Hospital Surge Coordination',
    description: 'Coordinate with hospitals to prepare for a surge of patients.',
    icon: 'ambulance',
    keywords: ['hospital', 'surge', 'capacity', 'beds', 'coordinate'],
  },
  {
    id: 'alt_supply',
    label: 'Alternative Supply Setup',
    description: 'Establish alternative water or food distribution.',
    icon: 'supply',
    keywords: ['alternative', 'supply', 'water', 'food', 'distribution'],
  },
  {
    id: 'public_advisory',
    label: 'Public Health Advisory',
    description: 'Issue a health advisory with precautions for the affected area.',
    icon: 'pa_system',
    keywords: ['advisory', 'warning', 'precaution', 'health alert'],
  },
  {
    id: 'sample_collection',
    label: 'Sample Collection',
    description: 'Collect environmental and biological samples for analysis.',
    icon: 'water_sample',
    keywords: ['sample', 'collection', 'environmental', 'biological', 'lab'],
  },
];

const OPERATIONS_ACTIONS: TeamAction[] = [
  {
    id: 'activate_ops_center',
    label: 'Activate Operations Centre',
    description: 'Stand up the central operations / command centre.',
    icon: 'ops_center',
    keywords: ['operations', 'command', 'centre', 'activate', 'stand up'],
  },
  {
    id: 'utility_isolation',
    label: 'Utility Isolation',
    description: 'Shut off gas, electricity, or water mains to the affected area.',
    icon: 'utility',
    keywords: ['utility', 'gas', 'electricity', 'water', 'isolate', 'shut off'],
  },
  {
    id: 'generator_deploy',
    label: 'Deploy Emergency Generators',
    description: 'Position portable generators to restore critical power.',
    icon: 'supply',
    keywords: ['generator', 'power', 'emergency', 'backup'],
  },
  {
    id: 'route_clearance',
    label: 'Route Clearance',
    description: 'Clear debris and ensure access routes for emergency vehicles.',
    icon: 'barrier',
    keywords: ['route', 'clearance', 'debris', 'access', 'road'],
  },
  {
    id: 'structural_shoring',
    label: 'Structural Shoring',
    description: 'Shore up compromised structures to prevent further collapse.',
    icon: 'barrier',
    keywords: ['shoring', 'structural', 'collapse', 'support'],
  },
];

const TEAM_ACTION_REGISTRY: Record<string, TeamAction[]> = {
  police: POLICE_ACTIONS,
  negotiation: NEGOTIATION_ACTIONS,
  intelligence: INTELLIGENCE_ACTIONS,
  close_protection: CLOSE_PROTECTION_ACTIONS,
  event_security: EVENT_SECURITY_ACTIONS,
  crowd_management: CROWD_MANAGEMENT_ACTIONS,
  transit_security: TRANSIT_SECURITY_ACTIONS,
  evacuation: EVACUATION_ACTIONS,
  triage: TRIAGE_ACTIONS,
  media: MEDIA_ACTIONS,
  fire_hazmat: FIRE_HAZMAT_ACTIONS,
  fire: FIRE_ACTIONS,
  bomb_squad: BOMB_SQUAD_ACTIONS,
  mall_security: MALL_SECURITY_ACTIONS,
  resort_security: RESORT_SECURITY_ACTIONS,
  public_health: PUBLIC_HEALTH_ACTIONS,
  operations: OPERATIONS_ACTIONS,
};

export function getTeamActions(
  teamName: string,
  elementType?: 'hazard' | 'casualty' | 'crowd' | 'entry_exit',
  _scenarioType?: string,
): TeamAction[] {
  const key = teamName.toLowerCase().replace(/[\s-]/g, '_');

  let actions = TEAM_ACTION_REGISTRY[key];
  if (!actions) {
    for (const [registryKey, registryActions] of Object.entries(TEAM_ACTION_REGISTRY)) {
      if (key.includes(registryKey) || registryKey.includes(key)) {
        actions = registryActions;
        break;
      }
    }
  }

  if (!actions) return [];

  if (elementType) {
    return actions.filter((a) => !a.requiresElement || a.requiresElement.includes(elementType));
  }

  return actions;
}
