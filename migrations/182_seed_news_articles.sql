-- Migration 182: Seed news articles for active social media crisis sessions
-- This inserts breaking news articles that contextually match the MBS explosion/racial tension scenario.
-- These articles provide the news environment that players must navigate during the crisis.

-- Note: This uses the session ID directly. For future sessions, news articles
-- will be auto-generated via injects or media NPC email publication.

INSERT INTO sim_news_articles (session_id, outlet_name, headline, subheadline, body, category, is_factual, published_at)
SELECT
  s.id,
  'Channel NewsAsia',
  'Explosion reported near Marina Bay Sands; emergency services responding',
  'Witnesses report loud blast and smoke; police cordoning off area',
  'SINGAPORE — An explosion was reported near the Marina Bay Sands integrated resort on Wednesday evening, with emergency services rushing to the scene.

Witnesses described hearing a loud blast at approximately 7:15 PM, followed by thick smoke rising from the vicinity. The Singapore Civil Defence Force (SCDF) confirmed that multiple emergency vehicles have been dispatched.

Police are establishing a cordon around the affected area and urging the public to avoid the Marina Bay district until further notice.

"We heard a very loud bang and saw people running," said one witness who was dining at a nearby restaurant. "There was smoke and security guards were telling everyone to evacuate."

The cause of the explosion has not yet been determined. The Singapore Police Force said in a brief statement that investigations are ongoing.

This is a developing story.',
  'breaking',
  true,
  s.start_time + INTERVAL '5 minutes'
FROM sessions s
WHERE s.status = 'in_progress' AND s.sim_mode = 'social_media'
AND NOT EXISTS (
  SELECT 1 FROM sim_news_articles n WHERE n.session_id = s.id AND n.headline LIKE '%Explosion reported near Marina Bay%'
);

INSERT INTO sim_news_articles (session_id, outlet_name, headline, subheadline, body, category, is_factual, published_at)
SELECT
  s.id,
  'The Straits Times',
  'MBS incident: At least 3 taken to hospital, police urge calm',
  'Authorities confirm injuries but no fatalities; racial tension rumors circulating online',
  'SINGAPORE — At least three people have been taken to hospital following an explosion near Marina Bay Sands (MBS) this evening, according to the Ministry of Health.

The Singapore Police Force (SPF) has confirmed that the incident is being investigated and urged the public not to speculate on the cause or spread unverified information on social media.

"We are aware of rumors circulating online regarding the identity of those involved. We urge the public to refrain from sharing unverified information that may stoke racial or religious tensions," an SPF spokesperson said.

Several social media posts have gone viral claiming to identify the perpetrators, though police have not confirmed any suspects.

The National Security Coordination Secretariat (NSCS) has activated its crisis management protocols. Hotels in the Marina Bay area are implementing lockdown procedures for guest safety.

More details are expected at a press conference scheduled for later this evening.',
  'developing',
  true,
  s.start_time + INTERVAL '15 minutes'
FROM sessions s
WHERE s.status = 'in_progress' AND s.sim_mode = 'social_media'
AND NOT EXISTS (
  SELECT 1 FROM sim_news_articles n WHERE n.session_id = s.id AND n.headline LIKE '%MBS incident: At least 3%'
);

INSERT INTO sim_news_articles (session_id, outlet_name, headline, subheadline, body, category, is_factual, published_at)
SELECT
  s.id,
  'TODAY Online',
  'Social media flooded with unverified claims about MBS blast; experts warn against sharing',
  'Misinformation spreading rapidly as authorities urge restraint',
  'SINGAPORE — Social media platforms have been flooded with unverified claims and speculation following the explosion near Marina Bay Sands, with media literacy experts warning that sharing such content could constitute an offence under Singapore law.

Multiple posts on X (formerly Twitter) and Facebook have claimed to identify the nationalities and motives of those allegedly responsible, despite police confirming that no arrests have been made and investigations are still in early stages.

Professor James Tan from the S. Rajaratnam School of International Studies noted: "In the immediate aftermath of such incidents, there is always a rush to assign blame. This is precisely when misinformation is most dangerous and can inflame communal tensions."

Under the Protection from Online Falsehoods and Manipulation Act (POFMA), individuals who spread false statements of fact may face fines and imprisonment.

The Infocomm Media Development Authority (IMDA) said it is monitoring the situation and may issue correction directions if necessary.',
  'analysis',
  true,
  s.start_time + INTERVAL '25 minutes'
FROM sessions s
WHERE s.status = 'in_progress' AND s.sim_mode = 'social_media'
AND NOT EXISTS (
  SELECT 1 FROM sim_news_articles n WHERE n.session_id = s.id AND n.headline LIKE '%Social media flooded with unverified%'
);

INSERT INTO sim_news_articles (session_id, outlet_name, headline, subheadline, body, category, is_factual, published_at)
SELECT
  s.id,
  'CNA',
  'Hotels in Marina Bay activate emergency protocols; guests told to shelter in place',
  NULL,
  'SINGAPORE — Hotels in the Marina Bay precinct, including Marina Bay Sands, Mandarin Oriental, and The Ritz-Carlton Millenia, have activated emergency shelter-in-place protocols following the explosion earlier this evening.

Guests at Marina Bay Sands reported being told to remain in their rooms via the in-house announcement system. Some guests on lower floors have been moved to internal ballrooms away from external-facing windows.

A spokesperson for MBS said: "The safety of our guests and team members is our top priority. We are cooperating fully with authorities and following emergency protocols."

The Land Transport Authority has also suspended MRT services at Bayfront and Marina Bay stations as a precautionary measure.',
  'breaking',
  true,
  s.start_time + INTERVAL '10 minutes'
FROM sessions s
WHERE s.status = 'in_progress' AND s.sim_mode = 'social_media'
AND NOT EXISTS (
  SELECT 1 FROM sim_news_articles n WHERE n.session_id = s.id AND n.headline LIKE '%Hotels in Marina Bay activate%'
);
