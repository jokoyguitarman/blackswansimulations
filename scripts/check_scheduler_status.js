/**
 * Quick script to check scheduler status and manually trigger if needed
 * Run this in browser console on your app page
 */

(async function diagnoseAndFix() {
  console.log('🔍 Diagnosing inject publishing issue...\n');

  // Get session
  const {
    data: { session: authSession },
  } = await supabase.auth.getSession();
  if (!authSession) {
    console.error('❌ Not logged in. Please log in first.');
    return;
  }

  const token = authSession.access_token;
  const sessionId = 'fae8ba20-49e2-4e4a-9b4e-dbdd9f358e57'; // Replace with your session ID

  // Step 1: Check diagnostic endpoint
  console.log('📊 Step 1: Running diagnostic...');
  const diagnosticRes = await fetch(
    `http://localhost:3001/api/sessions/${sessionId}/diagnose-injects`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    },
  );

  const diagnostic = await diagnosticRes.json();

  if (diagnostic.error) {
    console.error('❌ Diagnostic Error:', diagnostic.error);
    return;
  }

  console.log('✅ Diagnostic Results:');
  console.log('  Scheduler Enabled:', diagnostic.scheduler?.enabled);
  console.log('  Scheduler Running:', diagnostic.scheduler?.isRunning);
  console.log('  Session Status:', diagnostic.session?.status);
  console.log('  Elapsed Minutes:', diagnostic.session?.elapsedMinutes);
  console.log('  Injects Needing Publish:', diagnostic.injects?.needingPublish || 0);

  // Step 2: Check if scheduler is disabled
  if (!diagnostic.scheduler?.enabled) {
    console.log('\n⚠️  ISSUE FOUND: Scheduler is DISABLED!');
    console.log('   Solution: Set ENABLE_AUTO_INJECTS=true in your .env file');
    console.log('   Then restart the server.');
    return;
  }

  if (!diagnostic.scheduler?.isRunning) {
    console.log('\n⚠️  ISSUE FOUND: Scheduler is not running!');
    console.log('   This might mean the server needs to be restarted.');
    return;
  }

  // Step 3: Check session state
  if (diagnostic.session?.status !== 'in_progress') {
    console.log('\n⚠️  ISSUE FOUND: Session status is not "in_progress"!');
    console.log('   Current status:', diagnostic.session?.status);
    console.log('   Solution: Update session status to "in_progress"');
    return;
  }

  if (!diagnostic.session?.start_time) {
    console.log('\n⚠️  ISSUE FOUND: Session has no start_time!');
    console.log('   Solution: Session needs a start_time to calculate elapsed time');
    return;
  }

  // Step 4: Check if injects need publishing
  if (diagnostic.injects?.needingPublish > 0) {
    console.log('\n📋 Injects that need publishing:');
    diagnostic.injects.details.needingPublish.forEach((inject) => {
      console.log(`   - ${inject.title} (T+${inject.trigger_time_minutes})`);
    });

    console.log('\n🚀 Step 2: Triggering scheduler check...');
    const triggerRes = await fetch(
      `http://localhost:3001/api/sessions/${sessionId}/trigger-inject-check`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );

    const triggerResult = await triggerRes.json();
    console.log('✅ Trigger result:', triggerResult);

    // Wait a moment and check again
    console.log('\n⏳ Waiting 3 seconds, then checking again...');
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const checkAgainRes = await fetch(
      `http://localhost:3001/api/sessions/${sessionId}/diagnose-injects`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );

    const checkAgain = await checkAgainRes.json();
    console.log('\n📊 After trigger:');
    console.log('  Injects still needing publish:', checkAgain.injects?.needingPublish || 0);
    console.log('  Published count:', checkAgain.injects?.alreadyPublished || 0);

    if (checkAgain.injects?.needingPublish > 0) {
      console.log('\n⚠️  Some injects still need publishing. Check server logs for errors.');
    } else {
      console.log('\n✅ All injects have been published!');
    }
  } else {
    console.log('\n✅ All injects are already published or none need publishing.');
    console.log('   Published count:', diagnostic.injects?.alreadyPublished || 0);
  }
})();
