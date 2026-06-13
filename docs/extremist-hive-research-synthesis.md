# Extremist Hive — CVE Research Synthesis

**Purpose.** This is the evidence base for the "Opportunistic Extremist Hive" antagonist in the social-crisis training simulation. It synthesizes peer-reviewed and reputable institutional counter-extremism (CVE) research on _how_ extremist actors opportunistically exploit breaking social crises online.

**Scope & guardrails.** Everything here is descriptive/analytical — the _mechanics_ of manipulation as CVE analysts document them — so that trainees learn to recognize and counter division. It deliberately contains **no propaganda, slogans, theological/ideological argumentation, recruitment language, manifesto text, or operational content**. The simulation antagonist is designed to be _recognizable and counterable_, not authentic. Each exploitation pattern is paired with its documented defensive counter (Section F) to drive trainee scoring.

> This document is the design source for the planned `extremistDoctrine.ts` module. It was assembled from three parallel research agents plus targeted source pulls; see the Bibliography.

---

## Key finding: one engine, two skins

Jihadist and far-right actors use **nearly identical crisis-exploitation mechanics**. They differ mainly in the _grievance narrative_ they plug in, not the _method_. This means the hive can be modeled as a single opportunity-gated behavioral state machine that wears one of two ideological "skins."

```
            OPPORTUNITY (Section E)
                   |
        +----------v-----------+
        |  shared tactic set   |   (Section A)
        |  + actor roles       |   (Section C)
        |  + emotional levers  |   (Section D)
        +----------+-----------+
                   |
        +----------+-----------+
        |                      |
   jihadist skin          far-right skin     (Section B)
        |                      |
        +----------+-----------+
                   |
         each tactic <-> a documented counter (Section F)
```

---

## A. Shared crisis-exploitation tactics (the antagonist move-set)

| #   | Tactic                                   | Behavioral description (the _mechanic_)                                                                                   | Sources                                        |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| A1  | Data-void seizure                        | Rush framing into the early, low-information window before credible reporting exists                                      | Golebiewski & boyd 2019; Marwick & Lewis 2017  |
| A2  | Premature blame                          | Assert a culprit (identity/religion/immigration status) before facts are verified                                         | Innes et al. (GNET) 2021; Starbird et al. 2014 |
| A3  | News-jacking / narrative confirmation    | Reframe the live incident as "proof" of a pre-existing master narrative                                                   | Conway, Scrivens & Macnair 2019                |
| A4  | Wedge framing / division engineering     | Target messaging to deepen an us-vs-them split and provoke reciprocal hostility                                           | Berger 2018; Obaidi et al. 2022                |
| A5  | Exploiting silence                       | Recast official slowness/redaction as a cover-up; position self as the only honest source                                 | Innes et al. 2021; Paul & Matthews 2016        |
| A6  | Fogging                                  | Inject noise, contradiction, and pseudo-questions to erode confidence in any authoritative account                        | Innes et al. 2021                              |
| A7  | Flooding / firehose                      | Saturate the topic with high-volume, repetitive posting to dominate the visible conversation                              | Innes et al. 2021; Paul & Matthews 2016        |
| A8  | "Just asking questions" (JAQing)         | Frame assertions as innocent questions to evade fact-checks and shift burden of proof                                     | Marwick & Lewis 2017                           |
| A9  | Moral-outrage engineering                | Maximize the moral-emotional charge of content because outrage spreads farther and faster                                 | Brady et al. 2017; Crockett 2017               |
| A10 | Stochastic incitement                    | Dehumanizing rhetoric that raises the statistical likelihood of violence without an explicit, prosecutable call to action | ICCT/_Perspectives on Terrorism_ 2023          |
| A11 | Trading-up-the-chain / attention hacking | Seed content on fringe spaces, amplify via mid-tier accounts until mainstream coverage launders it                        | Marwick & Lewis 2017; Phillips 2018            |
| A12 | Pseudo-evidence legitimation             | Attach cherry-picked stats, fake "lists," or doctored documents to give conspiratorial framing a veneer of proof          | Ekman 2022                                     |
| A13 | Cross-platform funnelling                | Post "soft" framing on mainstream platforms, then route curious users toward less-moderated channels                      | ISD (Guhl, Ebner & Rau) 2020                   |

---

## B. Movement-specific "skins"

These change _what grievance is plugged in_, not the mechanics above.

### B1. Salafi-jihadist skin

- **"Extinction of the grayzone" polarization strategy** — deliberately provoke backlash against a minority so the space for coexistence collapses, forcing the population into binary camps; the resulting alienation and grievance are then converted into recruitment. Documented and analyzed academically. (Lakomy 2022, _Studies in Conflict & Terrorism_ 45(10); analyses of _Dabiq_ issue 7, 2015.)
- **Grievance-linking** — tie a "distant"/global humiliation narrative to a concrete _local_ grievance so it resonates with a specific audience. (ICCT / Bindner 2018.)
- **Swarmcast / "media mujahedeen" dissemination** — a decentralized, self-reconfiguring network of unaffiliated sympathizer "disseminators" reposts and adapts official content, giving a persistent presence resilient to takedowns. (Carter, Maher & Neumann / ICSR 2014; ICCT _Swarmcast_; ICCT ISIL-propaganda strategic objectives.)
- **Emotional core (per ORF synthesis):** exploit isolation, dissatisfaction, and the desire for belonging/respect to build an "us vs. them" mentality.

### B2. Far-right skin

- **"Great replacement" / demographic-threat framing** — recast random harm as evidence of a coordinated plot to "replace" a population. (Obaidi et al. 2022, _Group Processes & Intergroup Relations_; Ekman 2022, _Convergence_.)
- **Symbolic-threat scapegoating** — blame an out-group for threatening identity/culture/status rather than for measurable harms (the lever that most strongly predicts hostility). (Obaidi et al. 2022.)
- **Ironic / meme-based deniability** — couch hostile claims as jokes to evade moderation and retain "just joking" deniability. (NCTV 2024; _Television & New Media_ 2023; Marwick & Lewis 2017.)
- **Accelerationism** — welcome/stoke chaos and division as the goal itself, to hasten system collapse. (GNET 2022; Macklin, _CTC Sentinel_ 2019.)
- **Attacker veneration / memetic inspiration** — reference or lionize past perpetrators to inspire copycats. (Macklin 2019; GNET 2022.)

---

## C. Actor-role typology (the persona roster)

Both ecosystems share functional, behavioral roles. These map directly to hive personas (one account can occupy several roles).

1. **Ideologue / intellectual leader** — supplies the master narrative and "respectable" framing. (Miller-Idriss 2020; Davey & Ebner 2017.)
2. **Amplifier / disseminator** — mid-to-large account that picks up fringe content and pushes it to broader audiences (the "media mujahid" / influencer node). (Davey & Ebner 2017; Marwick & Lewis 2017; ICSR 2014.)
3. **Meme-maker / shitposter** — high-volume, deniable, virality-optimized content; the production layer. (NCTV 2024; Marwick & Lewis 2017.)
4. **Pseudo-news / "cloaked" aggregator** — partisan or fabricated content dressed in the format of neutral journalism. (Daniels 2009; ISD 2020.)
5. **Scout / target-spotter** — identifies the trending crisis opening and points the amplifier crowd at it. (IDZ/ISD 2020.)
6. **Coordinated amplifier crowd** — sockpuppet/raid cluster that executes flooding and hashtag-capture on cue. (Davey & Ebner 2017; Marwick & Lewis 2017.)
7. **Platform-bridger / funneller** — shepherds audiences from open platforms toward less-moderated channels. (ISD 2020/2022.)
8. **Recruiter / community-builder** — converts crisis-driven attention into belonging and identity. (Miller-Idriss 2020.)

---

## D. Emotional / psychological levers

The affective "buttons" the literature identifies as exploited during crises:

- **Fear / symbolic threat** to identity, status, culture (stronger predictor of hostility than material threat). (Obaidi et al. 2022.)
- **Grievance / resentment** recoded as righteous outrage. (Miller-Idriss; ICCT/Bindner 2018.)
- **Humiliation / wounded status.** (Miller-Idriss 2025.)
- **Belonging / community** offered against crisis-driven loneliness. (Miller-Idriss 2020.)
- **Nostalgia / loss of a "golden age."** (Ekman 2022.)
- **Moral outrage** (spreads faster and farther; strongest within in-groups). (Crockett 2017; Brady et al. 2017.)
- **Existential anxiety / mortality salience** after attacks. (Fischer-Preßler et al. 2019.)
- **Disgust / dehumanization** of out-groups as "folk devils." (ICCT/_Perspectives on Terrorism_ 2023.)
- **Distrust / epistemic insecurity** so the audience relies on the in-group for "truth." (Innes et al. 2021; Marwick & Lewis 2017.)

---

## E. Timing / "opportunity" dynamics (the gate logic)

The exploitable window is the **early, unsettled phase** of a crisis:

- **Voids are time-bounded** — manipulators race to fill them before credible content arrives. (Golebiewski & boyd 2019.)
- **Attention spikes are the trigger** — a void is latent until a crisis surges searches/attention onto the topic. (Golebiewski & boyd 2019.)
- **Anchor first; corrections lag** — the first version of events anchors belief and is hard to dislodge. (Paul & Matthews 2016; Starbird et al. 2014.)
- **Official silence is itself the opening** — where authorities are slow, the rumor mill defines the narrative first. (Paul & Matthews 2016.)
- **Falsehood out-travels truth** — false news spreads farther/faster/deeper, driven by novelty and high-arousal emotion; humans, not bots, are the main accelerant. (Vosoughi, Roy & Aral 2018, _Science_.)
- **Self-reinforcing cycles** — amplified claims trigger reactions that are re-amplified as fresh "evidence," extending the window. (Starbird et al. 2023.)

**Design implication:** the hive should _lurk_ and only strike when it detects an opening — fresh unaddressed harmful post, demographic fault line, rising escalation, collapsing narrative control, or conspicuous official silence — with cadence caps so it stays deliberate rather than spammy.

---

## F. Documented defensive counters (the trainee scoring rubric)

The literature also defines what "good" looks like — the win conditions trainees should learn:

- **Prebunking / inoculation** — forewarn + expose to a weakened dose of a technique to build resistance; target _techniques_, not just individual claims. (Roozenbeek & van der Linden 2019; Roozenbeek et al. 2022, _Science Advances_.)
- **Fill the void fast** with credible, contextualizing content (removes the data deficit). (Golebiewski & boyd 2019; Wardle & Derakhshan 2017.)
- **Rapid, repeated, source-credible official response** — compete on speed rather than chasing every lie. (Paul & Matthews 2016.)
- **"Truth sandwich" debunk** — lead with the fact, warn before repeating the myth, state the myth once, supply an alternative explanation (counters the continued-influence effect). (Lewandowsky et al. 2020, _Debunking Handbook 2020_.)
- **Accuracy nudges** — shifting attention to accuracy before sharing reduces spread of false content. (Pennycook et al. 2021, _Nature_.)
- **Amplify corrections deliberately** — corrections under-propagate, so defenders must boost reach/cadence. (Starbird et al. 2014; Vosoughi et al. 2018.)

---

## G. Mapping to hive / NPC design

| Research element   | Maps to                                                                                |
| ------------------ | -------------------------------------------------------------------------------------- |
| Section A tactics  | `EXTREMIST_MOVES` catalog (the antagonist's action repertoire)                         |
| Section B skins    | Two doctrine variants selected per session/scenario (grievance narrative only)         |
| Section C roles    | `EXTREMIST_CELL` persona roster (ideologue, amplifier, meme-maker, pseudo-news, scout) |
| Section D levers   | Tone/affect parameters in the post-generation prompt                                   |
| Section E timing   | The opportunity gate + cadence logic in `runExtremistHive`                             |
| Section F counters | Trainee scoring signals / AAR "missed counter" detection                               |

**Containment principle:** generated posts must read as _recognizably divisive bait a responder must neutralize_ — never as functional recruitment content, real theological/ideological argument, real slogans, or anything operational.

---

## Bibliography

### Peer-reviewed journals

- Lakomy, M. (2022). "Between the 'Camp of Falsehood' and the 'Camp of Truth': Exploitation of Propaganda Devices in the _Dabiq_ Online Magazine." _Studies in Conflict & Terrorism_, 45(10). https://www.tandfonline.com/doi/abs/10.1080/1057610X.2020.1711601
- Obaidi, M., Kunst, J., Ozer, S., & Kimel, S. Y. (2022). "The 'Great Replacement' conspiracy: How the perceived ousting of Whites can evoke violent extremism and Islamophobia." _Group Processes & Intergroup Relations_, 25(7). https://journals.sagepub.com/doi/10.1177/13684302211028293
- Ekman, M. (2022). "The great replacement: Strategic mainstreaming of far-right conspiracy claims." _Convergence_, 28(4). https://journals.sagepub.com/doi/10.1177/13548565221091983
- Fischer-Preßler, D., Schwemmer, C., & Fischbach, K. (2019). "Collective sense-making in times of crisis: Connecting terror management theory with Twitter reactions to the Berlin terrorist attack." _Computers in Human Behavior_, 100.
- Carter, J. A., Maher, S., & Neumann, P. R. (2014). "Tweeting the Jihad: Social Media Networks of Western Foreign Fighters in Syria and Iraq." _Studies in Conflict & Terrorism_ / ICSR. https://www.tandfonline.com/doi/full/10.1080/1057610X.2014.974948
- Berger, J. M. (2018). _Extremism_. MIT Press.
- Crockett, M. J. (2017). "Moral outrage in the digital age." _Nature Human Behaviour_, 1, 769–771. https://www.nature.com/articles/s41562-017-0213-3
- Brady, W. J., Wills, J. A., Jost, J. T., Tucker, J. A., & Van Bavel, J. J. (2017). "Emotion shapes the diffusion of moralized content in social networks." _PNAS_, 114(28). https://www.pnas.org/doi/abs/10.1073/pnas.1618923114
- Berger, J., & Milkman, K. L. (2012). "What Makes Online Content Viral?" _Journal of Marketing Research_, 49(2). https://journals.sagepub.com/doi/10.1509/jmr.10.0353
- Vosoughi, S., Roy, D., & Aral, S. (2018). "The spread of true and false news online." _Science_, 359(6380). https://www.science.org/doi/10.1126/science.aap9559
- Pennycook, G., et al. (2021). "Shifting attention to accuracy can reduce misinformation online." _Nature_, 592. https://www.nature.com/articles/s41586-021-03344-2
- Roozenbeek, J., & van der Linden, S. (2019). "Fake news game confers psychological resistance against online misinformation." _Palgrave Communications_, 5, 65. https://www.nature.com/articles/s41599-019-0279-9
- Roozenbeek, J., et al. (2022). "Psychological inoculation improves resilience against misinformation on social media." _Science Advances_, 8(34). https://www.science.org/doi/10.1126/sciadv.abo6254
- Daniels, J. (2009). "Cloaked websites: Propaganda, cyber-racism and epistemology in the digital era." _New Media & Society_, 11(5).
- (Venue-attributed) (2023). "Humor, Ridicule, and the Far Right: Mainstreaming Exclusion Through Online Animation." _Television & New Media_. https://journals.sagepub.com/doi/10.1177/15274764231213816

### Terrorism-studies venues (ICCT / Perspectives on Terrorism / CTC Sentinel)

- ICCT/_Perspectives on Terrorism_ (2023). "Stochastic Terrorism: A Linguistic and Psychological Analysis." https://pt.icct.nl/sites/default/files/2023-04/Article%201_12.pdf
- Macklin, G. (2019). "The Christchurch Attacks: Livestream Terror in the Viral Video Age." _CTC Sentinel_, 12(6).
- Conway, M., Scrivens, R., & Macnair, L. (2019). "Right-Wing Extremists' Persistent Online Presence: History and Contemporary Trends." ICCT / VOX-Pol. https://icct.nl
- ICCT (2024). "ISIL Propaganda" (strategic objectives overview). https://icct.nl/sites/default/files/2024-06/5%20ISIL%20Propaganda.pdf
- Bindner, L. (2018). "Jihadists' Grievance Narratives Against France." ICCT. https://icct.nl/sites/default/files/import/publication/Bindner-Jihadists-Grievance-Narratives-Against-France-February2018.pdf
- "Swarmcast: How Jihadist Networks Maintain a Persistent Online Presence." _Perspectives on Terrorism_ / ICCT. https://pt.icct.nl/article/swarmcast-how-jihadist-networks-maintain-persistent-online-presence

### Institutional research (GNET, ISD, Data & Society, IDZ, NCTV, RAND, Council of Europe)

- Innes, M., et al. (2021). "'Fogging' and 'Flooding': Countering Extremist Mis/Disinformation After Terror Attacks." GNET. https://gnet-research.org/2021/11/08/fogging-and-flooding-countering-extremist-mis-disinformation-after-terror-attacks/
- GNET (2022). "The Role of Violent Conspiratorial Narratives in Violent and Non-Violent Extreme Right Manifestos Online, 2015–2020." https://gnet-research.org/wp-content/uploads/2022/03/GNET-Report-The-Role-of-Violent-Conspiratorial-Narratives.pdf
- Davey, J., & Ebner, J. (2017). "The Fringe Insurgency: Connectivity, Convergence and Mainstreaming of the Extreme Right." ISD. https://www.isdglobal.org/wp-content/uploads/2017/10/The-Fringe-Insurgency-221017_2.pdf
- Guhl, J., Ebner, J., & Rau, J. (2020). "The Online Ecosystem of the German Far-Right." ISD. https://www.isdglobal.org/wp-content/uploads/2020/02/ISD-The-Online-Ecosystem-of-the-German-Far-Right-English-Draft-11.pdf
- IDZ Jena / ISD (2020). "Hate Not Found?!" https://www.idz-jena.de/fileadmin/user_upload/Hate_not_found/IDZ_Research_Report_Hate_not_Found.pdf
- Marwick, A. E., & Lewis, R. (2017). "Media Manipulation and Disinformation Online." Data & Society. https://datasociety.net/library/media-manipulation-and-disinfo-online/
- Golebiewski, M., & boyd, d. (2019). "Data Voids: Where Missing Data Can Easily Be Exploited." Data & Society. https://datasociety.net/library/data-voids/
- Phillips, W. (2018). "The Oxygen of Amplification." Data & Society.
- NCTV (Netherlands) (2024). "Memes as an Online Weapon: Far-Right Memes." https://english.nctv.nl/
- Paul, C., & Matthews, M. (2016). "The Russian 'Firehose of Falsehood' Propaganda Model." RAND PE-198. https://www.rand.org/pubs/perspectives/PE198.html
- Kavanagh, J., & Rich, M. D. (2018). _Truth Decay._ RAND RR-2314. https://www.rand.org/pubs/research_reports/RR2314.html
- Wardle, C., & Derakhshan, H. (2017). "Information Disorder." Council of Europe / First Draft. https://rm.coe.int/information-disorder-toward-an-interdisciplinary-framework-for-research/168076277c
- Starbird, K., Maddock, J., Orand, M., Achterman, P., & Mason, R. M. (2014). "Rumors, False Flags, and Digital Vigilantes: Misinformation on Twitter after the 2013 Boston Marathon Bombing." iConference 2014. https://www.ideals.illinois.edu/items/47268
- Starbird, K., Arif, A., & Wilson, T. (2019). "Disinformation as Collaborative Work." _Proceedings of the ACM on HCI (CSCW)_.
- Starbird, K., DiResta, R., & DeButts, M. (2023). "Influence and Improvisation: Participatory Disinformation during the 2020 US Election." _Social Media + Society_, 9(2). https://journals.sagepub.com/doi/10.1177/20563051231177943
- ORF (2023). "Extremist Propaganda on Social Media: Impact, Challenges, and Countermeasures." https://www.orfonline.org/research/extremist-propaganda-on-social-media-impact-challenges-and-countermeasures

### Books

- Miller-Idriss, C. (2020). _Hate in the Homeland: The New Global Far Right._ Princeton University Press.
- Miller-Idriss, C. (2025). _Man Up: The New Misogyny and the Rise of Violent Extremism._ Princeton University Press.

---

## Verification notes

- Citations were checked against publisher/journal pages by the research agents; a small number (the _Television & New Media_ far-right-humor article and the ICCT stochastic-terrorism piece) should have exact author names confirmed against the source PDFs before any external publication.
- Full page text for several sources was cached locally during research under `agent-tools/` (gitignored work area) if deeper extraction is needed.
