// Quick test script to check Grok video API response structure
// Run: node test-grok-video.mjs YOUR_XAI_API_KEY

const XAI_API_KEY = process.argv[2];
if (!XAI_API_KEY) {
  console.error('Usage: node test-grok-video.mjs YOUR_XAI_API_KEY');
  process.exit(1);
}

const XAI_BASE = 'https://api.x.ai/v1';

async function test() {
  console.log('1. Starting video generation...');

  const startRes = await fetch(`${XAI_BASE}/videos/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'grok-imagine-video',
      prompt: 'A calm ocean wave rolling onto a sandy beach at sunset',
      duration: 5,
      resolution: '480p',
      aspect_ratio: '16:9',
    }),
  });

  console.log('   Start response status:', startRes.status);
  const startData = await startRes.json();
  console.log('   Start response body:', JSON.stringify(startData, null, 2));

  const requestId = startData.request_id || startData.id;
  if (!requestId) {
    console.log('   No request_id found. Available keys:', Object.keys(startData));
    return;
  }

  console.log(`\n2. Polling for video ${requestId}...`);

  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 5000));

    const pollRes = await fetch(`${XAI_BASE}/videos/${requestId}`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${XAI_API_KEY}`,
      },
    });

    console.log(`   Poll ${i + 1} - status: ${pollRes.status}`);
    const pollData = await pollRes.json();
    console.log(`   Poll ${i + 1} - body:`, JSON.stringify(pollData, null, 2));

    const status = pollData.status || pollData.state;
    if (status === 'completed' || status === 'succeeded' || pollData.url || pollData.video_url) {
      console.log('\n   VIDEO READY!');
      return;
    }
    if (status === 'failed' || status === 'error') {
      console.log('\n   VIDEO FAILED');
      return;
    }
  }

  console.log('\n   Timed out after 40 polls');
}

test().catch(console.error);
