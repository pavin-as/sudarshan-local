# Gemini API Integration — Requirements & Setup Guide

## What You Need to Provide

To implement the rule validation system with Google Gemini API, I need the following information from you:

---

## 1. Gemini API Key

**What I need:**
- Your Google Gemini API key
- Where to store it: `PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', '...')`

**How to get it:**
1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Click "Create API Key"
3. Copy the key
4. Store it securely in Apps Script (never hardcode in files)

**Cost reference:**
- Gemini 1.5 Flash: Free tier available (15 RPM, 1M tokens/day)
- Gemini 1.5 Pro: Paid, ~$0.00125/1K input tokens

---

## 2. Gemini Model Choice

**Recommended options:**

| Model | Speed | Cost | Quality | Best For |
|-------|-------|------|---------|----------|
| `gemini-1.5-flash` | Fast (~2 sec) | Free tier | Good | Daily rule summaries (recommended) |
| `gemini-1.5-pro` | Slower (~5 sec) | Paid | Excellent | Complex analysis |
| `gemini-2.0-flash-exp` | Fastest | Free | Good | Latest experimental |

**Default I will use:** `gemini-1.5-flash` (free, fast, sufficient for formatting)

---

## 3. Decisions Needed From You

### A. Where should the "Check Rules" button trigger?

- [ ] Only when user clicks a button (manual)
- [ ] Automatically when day loads (auto-check)
- [ ] Both (auto on load + button to re-check)

### B. When should rules check happen during print?

- [ ] Always include rule notes in PDF
- [ ] Optional (ask user "Include rule notes?" before printing)
- [ ] Only if violations found (skip notes section if clean)

### C. LLM response language?

- [ ] English (default)
- [ ] Mix of English + medical terms
- [ ] Same as UI language

### D. Maximum number of violations to send to LLM?

- Default: 50 violations
- If more than 50, send top 50 by severity, then summarize rest
- **Confirm:** Is 50 reasonable for your clinic?

### E. LLM timeout handling?

If LLM takes >10 seconds:
- [ ] Wait (user sees loading spinner)
- [ ] Cancel and use fallback plain-text summary
- [ ] Show error and let user retry

---

## 4. Data Already Available (No Action Needed)

The system will use these existing fields from the `appointment` sheet:

| Field | Used For |
|-------|----------|
| `AppointmentID` | Unique identifier |
| `AppointmentDate` | Day-of-week calculation |
| `TimeSlot` | Time-based rules (10 AM, 4 PM, etc.) |
| `PatientName` | Display in violations |
| `MRDNo` | Patient identifier |
| `Age` | Pediatric detection |
| `PatientType` | New/Old detection |
| `PlanOfAction` | Procedure parsing (HFA, Laser, ROP, etc.) |
| `Remarks` | VIP/BNI/wheelchair/SVV detection |
| `Family Identifier` | Family grouping rules |
| `Consult Start` | Consultation window rules |
| `Doctor` | Per-doctor filtering |

**No schema changes required.**

---

## 5. Gemini API Endpoint Reference

**Endpoint:**
```
https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}
```

**Request format (Apps Script):**
```javascript
const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

const payload = {
  contents: [{
    parts: [{
      text: "Your prompt here"
    }]
  }],
  generationConfig: {
    temperature: 0.3,
    maxOutputTokens: 800,
    topP: 0.8,
    topK: 40
  }
};

const options = {
  method: 'post',
  contentType: 'application/json',
  payload: JSON.stringify(payload),
  muteHttpExceptions: true
};

const response = UrlFetchApp.fetch(url, options);
const result = JSON.parse(response.getContentText());
const summary = result.candidates[0].content.parts[0].text;
```

---

## 6. Setup Script (Run Once)

Add this function to `Code.js` and run it once from GAS editor:

```javascript
function setupGeminiApiKey() {
  // PASTE YOUR GEMINI API KEY BELOW (between quotes)
  const apiKey = 'YOUR_GEMINI_API_KEY_HERE';
  
  PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', apiKey);
  PropertiesService.getScriptProperties().setProperty('GEMINI_MODEL', 'gemini-1.5-flash');
  
  Logger.log('✅ Gemini API key configured');
  Logger.log('Model: gemini-1.5-flash');
}
```

**After running once, delete the function or remove the API key from it for security.**

---

## 7. Test Function (Verify Connection)

Add this to test the API connection:

```javascript
function testGeminiConnection() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  
  if (!apiKey) {
    Logger.log('❌ API key not found. Run setupGeminiApiKey() first.');
    return;
  }
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  
  const payload = {
    contents: [{
      parts: [{
        text: "Say 'Hello from Gemini!' in 5 words or less."
      }]
    }]
  };
  
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  try {
    const response = UrlFetchApp.fetch(url, options);
    const result = JSON.parse(response.getContentText());
    
    if (result.candidates && result.candidates[0]) {
      Logger.log('✅ Connection successful!');
      Logger.log('Response: ' + result.candidates[0].content.parts[0].text);
    } else if (result.error) {
      Logger.log('❌ API Error: ' + result.error.message);
    }
  } catch (e) {
    Logger.log('❌ Exception: ' + e.message);
  }
}
```

**Run this once to verify everything works.**

---

## 8. Implementation Checklist

Before I start coding, confirm:

- [ ] You have a Gemini API key
- [ ] You've decided on the model (default: `gemini-1.5-flash`)
- [ ] You've answered the 5 decision questions above
- [ ] You're okay with storing the API key in `PropertiesService` (server-side, not visible to users)
- [ ] You understand this will add a small dependency on Google's API (with fallback if it fails)

---

## 9. What Happens If Gemini API Fails

The system will automatically fall back to plain-text violation list:

```
⚠ 5 rule violations found:

🔴 ROP patient "Baby X" scheduled on Monday (should be Wednesday)
🟡 Non-HFA patient "John" occupies HFA slot at 9:20
🟡 Laser patient "Jane" scheduled on Thursday (should be Tue/Fri)
...
```

No data loss, no broken UI — just less polished formatting.

---

## 10. Rate Limits & Quotas

**Gemini 1.5 Flash Free Tier:**
- 15 requests per minute
- 1 million tokens per day
- 1,500 requests per day

**For your use case:**
- 1 request per "Check Rules" click
- 1 request per print/PDF generation
- Estimated: 20-50 requests/day maximum
- Well within free tier

---

## Next Steps

1. **Provide your Gemini API key** (or confirm you'll add it via `setupGeminiApiKey()`)
2. **Answer the 5 decision questions** (A through E)
3. **I'll implement the system** following the plan in `plan.md`
4. **You'll test** using `testGeminiConnection()` and the "Check Rules" button

**Ready to proceed once you confirm the above.**
</content>
