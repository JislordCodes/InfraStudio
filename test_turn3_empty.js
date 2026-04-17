const fs = require('fs');

async function test() {
  try {
    const res = await fetch('https://gitfkenmwzrldzqunvww.supabase.co/functions/v1/gemini-chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdpdGZrZW5td3pybGR6cXVudnd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3Nzg4NzYsImV4cCI6MjA3MTM1NDg3Nn0.7WQtp9TSHnJjoq39_LVhqjDYU2HbGAxfnleaHMS5VZU'
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
