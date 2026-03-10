-- C2E: Fold exit capacity assessment into the flow control inject.
-- Same conditions (bottleneck + no flow control), same cancel (flow_control_decided).
-- Content now explicitly asks for exit widths, flow rates, and distribution.

UPDATE scenario_injects
SET content = 'Congestion at the exit is worsening. Crowds are bunching and there is a risk of crush or stampede. Evacuation lead reports that without a clear flow-control or staggered-egress decision, the bottleneck cannot be safely managed. The coordination centre asks: what is your exit capacity assessment? Specify exit widths, flow rates (people per minute per exit), and how you plan to distribute evacuees across exits to avoid overcrowding. Coordination with triage on priority cases is also lacking.'
WHERE scenario_id = (SELECT id FROM scenarios WHERE title = 'C2E Bombing at Community Event' LIMIT 1)
  AND title = 'Exit bottleneck – flow control needed';
