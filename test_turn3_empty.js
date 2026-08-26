const fs = require('fs');

async function test() {
  try {
    const res = await fetch('https://gitfkenmwzrldzqunvww.supabase.co/functions/v1/gemini-chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY || ''}`
      },
      body: JSON.stringify({ action: 'turn3_execute', code: '' })
    });
    console.log('STATUS:', res.status);
    console.log('BODY:', await res.text());
  } catch(e) {
    console.error('Network Error:', e);
  }
}
test();
