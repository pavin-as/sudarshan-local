/**
 * API_setting.gs — Centralized API configuration
 *
 * Stores provider credentials, AI models, campaigns, and active selections
 * in the `API_setting` sheet, manageable from the settings page.
 *
 * Categories:
 *   provider  — API provider credentials (apiKey, apiUrl, name, type)
 *   model     — AI model definitions (provider, modelId, displayName)
 *   campaign  — Campaign definitions (provider, campaignId, displayName)
 *   active    — Currently selected active configs (simple string values)
 *
 * Sheet columns: id, category, key, value (JSON), active, notes, LastModified, ModifiedBy
 */

function initializeApiSettingSheet() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("API_setting");
    if (sheet) {
      Logger.log("API_setting sheet already exists.");
      return true;
    }
    sheet = ss.insertSheet("API_setting");

    var headers = ["id", "category", "key", "value", "active", "notes", "LastModified", "ModifiedBy"];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

    var now = new Date();
    var defaults = [
      [1, "provider",  "gemini",  JSON.stringify({apiKey:"",apiUrl:"https://generativelanguage.googleapis.com",name:"Google Gemini",type:"llm"}),      true, "Google Gemini LLM",      now, "SYSTEM"],
      [2, "provider",  "aisensy", JSON.stringify({apiKey:"",apiUrl:"https://backend.aisensy.com/campaign/t1/api/v2",name:"AiSensy",type:"whatsapp"}), true, "AiSensy WhatsApp",       now, "SYSTEM"],
      [3, "model",     "gemini-2.5-flash", JSON.stringify({provider:"gemini",modelId:"gemini-2.5-flash",displayName:"Gemini 2.5 Flash"}),            true, "Recommended fast model",  now, "SYSTEM"],
      [4, "model",     "gemini-2.0-flash", JSON.stringify({provider:"gemini",modelId:"gemini-2.0-flash",displayName:"Gemini 2.0 Flash"}),            true, "Older model",             now, "SYSTEM"],
      [5, "campaign",  "main_wa", JSON.stringify({provider:"aisensy",campaignId:"sudarsdhan_appointment",displayName:"Appointment Reminders"}),       true, "Main WA campaign",         now, "SYSTEM"],
      [6, "active",    "llm_provider",  "\"gemini\"",            true, "Active LLM provider key",       now, "SYSTEM"],
      [7, "active",    "llm_model",     "\"gemini-2.5-flash\"",  true, "Active LLM model key",          now, "SYSTEM"],
      [8, "active",    "wa_provider",   "\"aisensy\"",            true, "Active WhatsApp provider key",  now, "SYSTEM"],
      [9, "active",    "wa_campaign",   "\"main_wa\"",           true, "Active WA campaign key",        now, "SYSTEM"],
    ];

    sheet.getRange(2, 1, defaults.length, headers.length).setValues(defaults);

    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight("bold");
    headerRange.setBackground("#4a90e2");
    headerRange.setFontColor("#ffffff");
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(4, 400);

    Logger.log("API_setting sheet created with " + defaults.length + " default rows.");
    return true;
  } catch (e) {
    Logger.log("Error initializing API_setting sheet: " + e.toString());
    return false;
  }
}

/**
 * Read all rows from the API_setting sheet.
 * Returns plain JS objects (parsed JSON in value column).
 */
function getApiSettingRows_() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("API_setting");
    if (!sheet) return [];
    var data = sheet.getDataRange().getValues();
    var rows = [];
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (!row[0]) continue;
      var parsed = {};
      try {
        parsed = JSON.parse(String(row[3]));
      } catch (e) {}
      rows.push({
        id: row[0],
        category: String(row[1] || "").trim(),
        key: String(row[2] || "").trim(),
        value: parsed,
        active: row[4] === true || row[4] === "TRUE" || row[4] === true,
        notes: String(row[5] || ""),
        lastModified: row[6] ? new Date(row[6]).toISOString() : "",
        modifiedBy: String(row[7] || ""),
      });
    }
    return rows;
  } catch (e) {
    Logger.log("Error reading API_setting rows: " + e.toString());
    return [];
  }
}

/**
 * Update a specific row's value + active + timestamp by category+key.
 */
function updateApiSettingRow_(category, key, newValue, active, modifiedBy) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("API_setting");
    if (!sheet) return false;
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (String(row[1] || "").trim() === category && String(row[2] || "").trim() === key) {
        var now = new Date();
        var valStr = typeof newValue === "string" ? newValue : JSON.stringify(newValue);
        sheet.getRange(i + 1, 4).setValue(valStr);
        if (active !== undefined) {
          sheet.getRange(i + 1, 5).setValue(active);
        }
        sheet.getRange(i + 1, 7).setValue(now);
        sheet.getRange(i + 1, 8).setValue(modifiedBy || "SYSTEM");
        return true;
      }
    }
    // Row doesn't exist — append
    var now = new Date();
    var nextId = data.length;
    var valStr = typeof newValue === "string" ? newValue : JSON.stringify(newValue);
    sheet.appendRow([nextId, category, key, valStr, active !== false, "", now, modifiedBy || "SYSTEM"]);
    return true;
  } catch (e) {
    Logger.log("Error updating API_setting row: " + e.toString());
    return false;
  }
}

/**
 * Load full API settings data for the settings page.
 * @param {string} sessionToken
 * @return {Object} { success, providers: [], models: [], campaigns: [], active: {} }
 */
function loadApiSettings(sessionToken) {
  try {
    var username = getSessionUsername(sessionToken);
    if (!username) return { success: false, error: "Session expired." };

    var rows = getApiSettingRows_();
    var result = { success: true, providers: [], models: [], campaigns: [], active: {} };

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.category === "provider") {
        result.providers.push(r);
      } else if (r.category === "model") {
        result.models.push(r);
      } else if (r.category === "campaign") {
        result.campaigns.push(r);
      } else if (r.category === "active") {
        if (r.active) result.active[r.key] = r.value;
      }
    }

    return result;
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Save active LLM and WhatsApp configuration.
 * @param {Object} config - { llmProvider, llmModel, waProvider, waCampaign }
 * @param {string} sessionToken
 * @return {Object} { success }
 */
function saveApiActiveConfig(config, sessionToken) {
  try {
    var username = getSessionUsername(sessionToken);
    if (!username) return { success: false, error: "Session expired." };
    if (!hasAccessLevel(sessionToken, 1)) {
      return { success: false, error: "Admin access required." };
    }

    if (config.llmProvider !== undefined) {
      updateApiSettingRow_("active", "llm_provider", JSON.stringify(config.llmProvider), true, username);
    }
    if (config.llmModel !== undefined) {
      updateApiSettingRow_("active", "llm_model", JSON.stringify(config.llmModel), true, username);
    }
    if (config.waProvider !== undefined) {
      updateApiSettingRow_("active", "wa_provider", JSON.stringify(config.waProvider), true, username);
    }
    if (config.waCampaign !== undefined) {
      updateApiSettingRow_("active", "wa_campaign", JSON.stringify(config.waCampaign), true, username);
    }

    logAuditEvent(sessionToken, "API_SETTINGS_CHANGE", "SETTINGS", "API_SETTINGS", {
      sheetName: "API_setting",
      config: config,
    });

    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Save/update a provider's credential (apiKey, apiUrl, name).
 * @param {string} providerKey - e.g. "gemini"
 * @param {Object} credentials - { apiKey, apiUrl, name }
 * @param {string} sessionToken
 * @return {Object} { success }
 */
function saveProviderCredential(providerKey, credentials, sessionToken) {
  try {
    var username = getSessionUsername(sessionToken);
    if (!username) return { success: false, error: "Session expired." };
    if (!hasAccessLevel(sessionToken, 1)) {
      return { success: false, error: "Admin access required." };
    }

    var rows = getApiSettingRows_();
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].category === "provider" && rows[i].key === providerKey) {
        var updated = rows[i].value;
        if (credentials.apiKey !== undefined) updated.apiKey = credentials.apiKey;
        if (credentials.apiUrl !== undefined) updated.apiUrl = credentials.apiUrl;
        if (credentials.name !== undefined) updated.name = credentials.name;
        updateApiSettingRow_("provider", providerKey, updated, true, username);

        logAuditEvent(sessionToken, "API_CREDENTIAL_SAVED", "SETTINGS", providerKey, {
          sheetName: "API_setting",
          updated: Object.keys(credentials),
        });

        return { success: true };
      }
    }

    return { success: false, error: "Provider '" + providerKey + "' not found." };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Get the active LLM configuration (for RuleEngine.js).
 * @return {Object} { providerKey, apiKey, apiUrl, modelId } or { error }
 */
function getActiveLLMConfig() {
  try {
    var rows = getApiSettingRows_();
    var active = {};
    var providers = {};

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.category === "active" && r.active) active[r.key] = r.value;
      if (r.category === "provider" && r.active) providers[r.key] = r.value;
    }

    var providerKey = active.llm_provider || "gemini";
    var modelId = active.llm_model || "gemini-2.5-flash";
    var provider = providers[providerKey];

    if (!provider) {
      // Fallback: try gemini
      provider = providers["gemini"];
    }

    if (!provider) {
      // Fallback to ScriptProperties (legacy)
      try {
        var legacyKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
        if (legacyKey) {
          return { providerKey: "gemini", apiKey: legacyKey, apiUrl: "https://generativelanguage.googleapis.com", modelId: modelId };
        }
      } catch (e) {}
      return { error: "No LLM provider configured." };
    }

    return {
      providerKey: providerKey,
      apiKey: String(provider.apiKey || ""),
      apiUrl: String(provider.apiUrl || "https://generativelanguage.googleapis.com"),
      modelId: modelId,
    };
  } catch (e) {
    Logger.log("getActiveLLMConfig error: " + e.toString());
    return { error: e.toString() };
  }
}

/**
 * Get the active WhatsApp configuration (for broadcast.js).
 * @return {Object} { providerKey, apiKey, apiUrl, campaignId } or { error }
 */
function getActiveWAConfig() {
  try {
    var rows = getApiSettingRows_();
    var active = {};
    var providers = {};
    var campaigns = {};

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.category === "active" && r.active) active[r.key] = r.value;
      if (r.category === "provider" && r.active) providers[r.key] = r.value;
      if (r.category === "campaign" && r.active) campaigns[r.key] = r.value;
    }

    var providerKey = active.wa_provider || "aisensy";
    var campaignKey = active.wa_campaign || "main_wa";
    var provider = providers[providerKey];
    var campaign = campaigns[campaignKey];

    if (!provider) {
      provider = providers["aisensy"];
    }

    if (!provider) {
      return { error: "No WhatsApp provider configured." };
    }

    var campaignId = (campaign && campaign.campaignId) || "sudarsdhan_appointment";

    return {
      providerKey: providerKey,
      apiKey: String(provider.apiKey || ""),
      apiUrl: String(provider.apiUrl || "https://backend.aisensy.com/campaign/t1/api/v2"),
      campaignId: campaignId,
    };
  } catch (e) {
    Logger.log("getActiveWAConfig error: " + e.toString());
    return { error: e.toString() };
  }
}

/**
 * Add or update a model (for future UI use).
 * @param {string} modelKey
 * @param {Object} modelData - { provider, modelId, displayName }
 * @param {string} sessionToken
 * @return {Object} { success }
 */
function saveApiModel(modelKey, modelData, sessionToken) {
  try {
    var username = getSessionUsername(sessionToken);
    if (!username) return { success: false, error: "Session expired." };
    if (!hasAccessLevel(sessionToken, 1)) {
      return { success: false, error: "Admin access required." };
    }
    updateApiSettingRow_("model", modelKey, modelData, true, username);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Add or update a campaign (for future UI use).
 * @param {string} campaignKey
 * @param {Object} campaignData - { provider, campaignId, displayName }
 * @param {string} sessionToken
 * @return {Object} { success }
 */
function saveApiCampaign(campaignKey, campaignData, sessionToken) {
  try {
    var username = getSessionUsername(sessionToken);
    if (!username) return { success: false, error: "Session expired." };
    if (!hasAccessLevel(sessionToken, 1)) {
      return { success: false, error: "Admin access required." };
    }
    updateApiSettingRow_("campaign", campaignKey, campaignData, true, username);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function toggleApiEntryActive(category, key, active, sessionToken) {
  try {
    var username = getSessionUsername(sessionToken);
    if (!username) return { success: false, error: "Session expired." };
    if (!hasAccessLevel(sessionToken, 1)) {
      return { success: false, error: "Admin access required." };
    }
    updateApiSettingRow_(category, key, null, active, username);
    logAuditEvent(sessionToken, "API_TOGGLE_ACTIVE", "SETTINGS", key, {
      sheetName: "API_setting",
      category: category,
      active: active,
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function deleteApiEntry(category, key, sessionToken) {
  try {
    var username = getSessionUsername(sessionToken);
    if (!username) return { success: false, error: "Session expired." };
    if (!hasAccessLevel(sessionToken, 1)) {
      return { success: false, error: "Admin access required." };
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("API_setting");
    if (!sheet) return { success: false, error: "API_setting sheet not found." };
    var data = sheet.getDataRange().getValues();
    for (var i = data.length - 1; i >= 1; i--) {
      if (String(data[i][1] || "").trim() === category && String(data[i][2] || "").trim() === key) {
        sheet.deleteRow(i + 1);
        logAuditEvent(sessionToken, "API_ENTRY_DELETED", "SETTINGS", key, {
          sheetName: "API_setting",
          category: category,
        });
        return { success: true };
      }
    }
    return { success: false, error: "Entry not found." };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

function addApiProvider(providerKey, providerData, sessionToken) {
  try {
    var username = getSessionUsername(sessionToken);
    if (!username) return { success: false, error: "Session expired." };
    if (!hasAccessLevel(sessionToken, 1)) {
      return { success: false, error: "Admin access required." };
    }
    updateApiSettingRow_("provider", providerKey, providerData, true, username);
    logAuditEvent(sessionToken, "API_PROVIDER_ADDED", "SETTINGS", providerKey, {
      sheetName: "API_setting",
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}
