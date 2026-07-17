#!/usr/bin/env node
/**
 * Quick test to verify Azure OpenAI credentials are working
 * Run: node test-azure-connection.js
 */
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('node:fs');
const path = require('node:path');

// Read .env.local
const envPath = path.join(__dirname, '.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');

const endpoint = envContent.match(/AZURE_AI_ENDPOINT=(.+)/)?.[1];
const apiKey = envContent.match(/AZURE_AI_KEY=(.+)/)?.[1];
const deploymentName = envContent.match(/AZURE_AI_DEPLOYMENT_NAME=(.+)/)?.[1];
const apiVersion = envContent.match(/AZURE_AI_API_VERSION=(.+)/)?.[1] || '2024-12-01-preview';

console.log('🔍 Verifying Azure OpenAI Configuration:');
console.log(`   Endpoint: ${endpoint ? '✅ Configured' : '❌ Missing'}`);
console.log(`   API Key: ${apiKey ? '✅ Configured' : '❌ Missing'}`);
console.log(`   Deployment: ${deploymentName ? '✅ Configured (' + deploymentName + ')' : '❌ Missing'}`);

if (!endpoint || !apiKey || !deploymentName) {
  console.error('\n❌ Missing credentials. Check .env.local');
  process.exit(1);
}

// Test connection
const testPayload = {
  messages: [
    { role: 'system', content: 'You are a test assistant.' },
    { role: 'user', content: 'Say "Azure connection successful" if you receive this.' },
  ],
  temperature: 0.5,
  max_completion_tokens: 100,
};

const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${deploymentName}/chat/completions?api-version=${apiVersion}`;

console.log(`\n🧪 Testing Azure API call to: ${url}`);

fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'api-key': apiKey,
  },
  body: JSON.stringify(testPayload),
})
  .then((res) => {
    console.log(`   Response status: ${res.status}`);
    if (!res.ok) {
      console.error(`   ❌ HTTP Error: ${res.status}`);
      return res.text().then(txt => { throw new Error(txt); });
    }
    return res.json();
  })
  .then((data) => {
    const responseText = data.choices?.[0]?.message?.content || '(no response)';
    console.log(`   ✅ Azure API responded!`);
    console.log(`   Response: "${responseText.substring(0, 80)}..."`);
    console.log('\n✅ Azure OpenAI connection verified!');
    process.exit(0);
  })
  .catch((err) => {
    console.error(`   ❌ Error: ${err.message}`);
    process.exit(1);
  });
