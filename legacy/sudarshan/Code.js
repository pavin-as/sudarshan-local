// Main entry point: renders login page or requested page based on session and page parameter.
function doGet(e) {
  var template;
  if (e.parameter.sessionToken) {
    var username = getSessionUsername(e.parameter.sessionToken);
    if (username) {
      if (e.parameter.page) {
        var page = e.parameter.page;
        try {
          template = HtmlService.createTemplateFromFile(page);
          template.sessionToken = e.parameter.sessionToken;
          template.webAppUrl = ScriptApp.getService().getUrl();

          // Add appointmentId to template if it exists in URL parameters
          if (e.parameter.appointmentId) {
            template.appointmentId = e.parameter.appointmentId;
          }

          var output = template
            .evaluate()
            .setTitle(page.charAt(0).toUpperCase() + page.slice(1))
            .addMetaTag("viewport", "width=device-width, initial-scale=1.0");
          return output;
        } catch (error) {
          return HtmlService.createHtmlOutput("Page not found.");
        }
      } else {
        template = HtmlService.createTemplateFromFile("dayOverview");
        template.sessionToken = e.parameter.sessionToken;
        template.webAppUrl = ScriptApp.getService().getUrl();

        var output = template
          .evaluate()
          .setTitle("Day Overview")
          .addMetaTag("viewport", "width=device-width, initial-scale=1.0");
        return output;
      }
    }
  }

  template = HtmlService.createTemplateFromFile("Login");
  template.webAppUrl = ScriptApp.getService().getUrl();

  return template
    .evaluate()
    .setTitle("Login")
    .addMetaTag("viewport", "width=device-width, initial-scale=1.0");
}

// Utility function to include other HTML files
function include(filename) {
  return HtmlService.createTemplateFromFile(filename).getRawContent();
}

// Validate login credentials from the "Login" sheet
function validateLogin(username, password) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName("Login");
  if (!sheet) {
    throw new Error("Login sheet not found!");
  }

  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === username && data[i][1] === password) {
      return true; // Credentials match
    }
  }
  return false; // Credentials do not match
}

// Create a session for the logged-in user
function createSession(username) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName("Login");
  let fullName = username;
  if (sheet) {
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === username) {
        fullName = data[i][3] || username; // Column D (index 3)
        break;
      }
    }
  }
  const userData = {
    username: username,
    fullName: fullName,
    role: getUserRole(username),
  };
  const sessionToken = createUserSession(userData);
  if (!sessionToken) {
    // Do not log LOGIN_SUCCESS or hand a null token to the browser — that
    // bounces the user back to the login screen with a misleading audit entry.
    throw new Error("Could not create a session. Please try again.");
  }

  // Log audit event for successful login
  try {
    logAuditEvent(sessionToken, "LOGIN_SUCCESS", "USER", username, {
      fullName: fullName,
      role: userData.role,
    });
  } catch (auditError) {
    // Don't fail login if audit logging fails
    Logger.log("Audit logging failed for login: " + auditError.toString());
  }

  return sessionToken;
}

// Retrieve username from the session token
function getSessionUsername(sessionToken) {
  const session = getUserSession(sessionToken);
  return session ? session.username : null;
}

// Retrieve full name from the session token
function getSessionFullName(sessionToken) {
  const session = getUserSession(sessionToken);
  return session ? session.fullName : null;
}

// Expose getSessionFullName for frontend use
function getCurrentUserFullName(sessionToken) {
  return getSessionFullName(sessionToken);
}

// Clear the session
function clearSession(sessionToken) {
  return deleteUserSession(sessionToken);
}

/**
 * Get user session information from the session token
 * @param {string} sessionToken - The session token to verify
 * @return {Object|null} User session object or null if invalid
 */
function getUserSession(sessionToken) {
  try {
    // Sessions live in the SCRIPT property store: one global, owner-scoped
    // store shared by all users. (Previously getUserProperties, which is
    // scoped per active Google account and fragmented/filled across the
    // shared reception logins.)
    const store = PropertiesService.getScriptProperties();

    // Get the session data
    const sessionData = store.getProperty(sessionToken);
    if (!sessionData) {
      return null;
    }

    // Parse the session data
    const session = JSON.parse(sessionData);

    // Check if session is expired (10 hours)
    const now = new Date().getTime();
    if (now - session.timestamp > 10 * 60 * 60 * 1000) {
      // Session expired, remove it
      store.deleteProperty(sessionToken);
      return null;
    }

    // Sliding-window refresh, but throttled: only rewrite if the stored
    // timestamp is more than 5 minutes old. getUserSession runs on every page
    // load and write, so an unconditional write would hammer the now-shared
    // store. Five-minute granularity keeps the 10h sliding window intact.
    if (now - session.timestamp > 5 * 60 * 1000) {
      session.timestamp = now;
      store.setProperty(sessionToken, JSON.stringify(session));
    }

    return session;
  } catch (error) {
    return null;
  }
}

/**
 * Create a new user session
 * @param {Object} userData - User data to store in session
 * @return {string} Session token
 */
function createUserSession(userData) {
  // Generate a unique session token
  const sessionToken = Utilities.getUuid();

  // Create session object
  const session = {
    ...userData,
    timestamp: new Date().getTime(),
  };

  const store = PropertiesService.getScriptProperties();
  const value = JSON.stringify(session);

  try {
    // Store session data
    store.setProperty(sessionToken, value);
    return sessionToken;
  } catch (error) {
    // The properties store is likely full (GAS caps it at ~500 KB).
    // Sweep expired/orphaned sessions to reclaim space, then retry once.
    Logger.log(
      "createUserSession: setProperty failed, attempting purge. " +
        error.toString(),
    );
    try {
      purgeExpiredSessions();
      store.setProperty(sessionToken, value);
      return sessionToken;
    } catch (retryError) {
      // Surface the failure instead of silently returning null. A null token
      // would otherwise be handed to the browser and bounce the user back to
      // the login screen with a misleading LOGIN_SUCCESS in the audit log.
      throw new Error(
        "Could not create session — the session store is full and could " +
          "not be cleared. Run purgeExpiredSessions() / purgeAllSessions(). " +
          retryError.toString(),
      );
    }
  }
}

/**
 * Delete sessions older than 10 hours (and any unparseable session-shaped
 * entries) from the script properties store. Safe to run anytime; it only
 * removes expired tokens, so currently logged-in users are unaffected.
 * Run from the editor for an immediate fix, and/or on a daily time trigger.
 * @return {Object} { scanned, deleted } counts
 */
function purgeExpiredSessions() {
  const store = PropertiesService.getScriptProperties();
  const all = store.getProperties();
  const now = new Date().getTime();
  const MAX_AGE_MS = 10 * 60 * 60 * 1000;

  let scanned = 0;
  let deleted = 0;

  for (const key in all) {
    scanned++;
    let session;
    try {
      session = JSON.parse(all[key]);
    } catch (e) {
      continue; // Not JSON — leave non-session properties untouched.
    }
    // Only treat objects that carry a numeric session timestamp as sessions.
    if (
      session &&
      typeof session === "object" &&
      typeof session.timestamp === "number"
    ) {
      if (now - session.timestamp > MAX_AGE_MS) {
        store.deleteProperty(key);
        deleted++;
      }
    }
  }

  Logger.log(
    "purgeExpiredSessions: scanned " + scanned + ", deleted " + deleted,
  );
  return { scanned: scanned, deleted: deleted };
}

/**
 * Install a daily time-driven trigger that runs purgeExpiredSessions().
 * Run this ONCE from the editor. Removes any existing copy first so it can't
 * be installed twice.
 */
function installSessionCleanupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === "purgeExpiredSessions")
    .forEach((t) => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger("purgeExpiredSessions")
    .timeBased()
    .everyDays(1)
    .atHour(2)
    .create();

  Logger.log("installSessionCleanupTrigger: daily cleanup trigger installed");
}

/**
 * Emergency reset: delete EVERY entry in the user-properties store. This logs
 * out all users (they must sign in again). Use only if purgeExpiredSessions()
 * does not free enough space.
 * @return {Object} { deleted } count
 */
function purgeAllSessions() {
  const store = PropertiesService.getScriptProperties();
  const count = Object.keys(store.getProperties()).length;
  store.deleteAllProperties();
  Logger.log("purgeAllSessions: deleted " + count + " properties");
  return { deleted: count };
}

/**
 * Delete a user session
 * @param {string} sessionToken - The session token to delete
 * @return {boolean} True if session was deleted successfully
 */
function deleteUserSession(sessionToken) {
  try {
    // Log audit event for logout BEFORE deleting the session
    try {
      const session = getUserSession(sessionToken);
      if (session && session.username) {
        logAuditEvent(sessionToken, "LOGOUT", "USER", session.username, {
          fullName: session.fullName,
          role: session.role,
        });
      }
    } catch (auditError) {
      // Don't fail logout if audit logging fails
      Logger.log("Audit logging failed for logout: " + auditError.toString());
    }

    const store = PropertiesService.getScriptProperties();
    store.deleteProperty(sessionToken);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Get user role from the Login sheet
 * @param {string} username - The username to get role for
 * @return {string} User role or 'user' if not found
 */
function getUserRole(username) {
  try {
    const ss = SpreadsheetApp.getActive();
    const sheet = ss.getSheetByName("Login");
    if (!sheet) {
      return "user";
    }

    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === username) {
        const role = data[i][2] || "user";
        return role; // Assuming role is in the third column
      }
    }

    return "user";
  } catch (error) {
    return "user";
  }
}

/**
 * Get user access level based on role
 * @param {string} role - The user's role
 * @return {number} Access level (1-4, where 1 is highest)
 */
function getUserAccessLevel(role) {
  const roleLevels = {
    director: 1,
    admin: 1,
    doctor: 2,
    manager: 3,
    user: 4,
    staff: 4,
    receptionist: 4,
    nurse: 4,
  };

  const normalizedRole = role ? role.toLowerCase().trim() : "user";
  return roleLevels[normalizedRole] || 4; // Default to level 4 for unknown roles
}

/**
 * Check if user has minimum required access level
 * @param {string} sessionToken - The session token to check
 * @param {number} requiredLevel - The minimum required access level (1-4)
 * @return {boolean} True if user has sufficient access level
 */
function hasAccessLevel(sessionToken, requiredLevel) {
  try {
    const session = getUserSession(sessionToken);
    if (!session) {
      return false;
    }

    const userLevel = getUserAccessLevel(session.role);

    return userLevel <= requiredLevel; // Lower number = higher access
  } catch (error) {
    return false;
  }
}

/**
 * Check if user is Level 1 (Director or Admin)
 * @param {string} sessionToken - The session token to check
 * @return {boolean} True if user is Level 1
 */
function isLevel1(sessionToken) {
  return hasAccessLevel(sessionToken, 1);
}

/**
 * Check if user is Level 2 (Doctor)
 * @param {string} sessionToken - The session token to check
 * @return {boolean} True if user is Level 2
 */
function isLevel2(sessionToken) {
  return hasAccessLevel(sessionToken, 2);
}

/**
 * Check if user is Level 3 (Manager)
 * @param {string} sessionToken - The session token to check
 * @return {boolean} True if user is Level 3
 */
function isLevel3(sessionToken) {
  return hasAccessLevel(sessionToken, 3);
}

/**
 * Check if user is Level 4 (General user)
 * @param {string} sessionToken - The session token to check
 * @return {boolean} True if user is Level 4
 */
function isLevel4(sessionToken) {
  return hasAccessLevel(sessionToken, 4);
}

/**
 * Get user's current access level
 * @param {string} sessionToken - The session token
 * @return {Object} Object containing success status and access level
 */
function getCurrentUserAccessLevel(sessionToken) {
  try {
    const session = getUserSession(sessionToken);
    if (!session) {
      return { success: false, message: "Invalid session" };
    }

    const level = getUserAccessLevel(session.role);
    const roleNames = {
      1: "Director/Admin",
      2: "Doctor",
      3: "Manager",
      4: "General User",
    };

    return {
      success: true,
      level: level,
      roleName: roleNames[level] || "Unknown",
      role: session.role,
      username: session.username,
    };
  } catch (error) {
    return { success: false, message: error.toString() };
  }
}

/**
 * Check if user has access to admin functions (Level 1 only)
 * @param {string} sessionToken - The session token to check
 * @return {boolean} True if user has admin access
 */
function hasAdminAccess(sessionToken) {
  return isLevel1(sessionToken);
}

/**
 * Check if user has access to doctor functions (Level 1 or 2)
 * @param {string} sessionToken - The session token to check
 * @return {boolean} True if user has doctor access
 */
function hasDoctorAccess(sessionToken) {
  return hasAccessLevel(sessionToken, 2);
}

/**
 * Check if user has access to manager functions (Level 1, 2, or 3)
 * @param {string} sessionToken - The session token to check
 * @return {boolean} True if user has manager access
 */
function hasManagerAccess(sessionToken) {
  return hasAccessLevel(sessionToken, 3);
}

/**
 * Check if user can delete appointments (Level 1 only)
 * @param {string} sessionToken - The session token to check
 * @return {boolean} True if user can delete appointments
 */
function canDeleteAppointments(sessionToken) {
  return isLevel1(sessionToken);
}

/**
 * Check if user can archive appointments (Level 1 or 2)
 * @param {string} sessionToken - The session token to check
 * @return {boolean} True if user can archive appointments
 */
function canArchiveAppointments(sessionToken) {
  return hasAccessLevel(sessionToken, 2);
}

/**
 * Check if user can update patient details (Level 1, 2, or 3)
 * @param {string} sessionToken - The session token to check
 * @return {boolean} True if user can update patient details
 */
function canUpdatePatientDetails(sessionToken) {
  return hasAccessLevel(sessionToken, 3);
}

/**
 * Check if user can view analytics (Level 1, 2, or 3)
 * @param {string} sessionToken - The session token to check
 * @return {boolean} True if user can view analytics
 */
function canViewAnalytics(sessionToken) {
  return hasAccessLevel(sessionToken, 3);
}

/**
 * Check if user can access visualization dashboard (Level 1 only)
 * @param {string} sessionToken - The session token to check
 * @return {boolean} True if user can access visualization
 */
function canAccessVisualization(sessionToken) {
  return isLevel1(sessionToken);
}

/**
 * Check if user can access settings configuration (Level 1 only)
 * @param {string} sessionToken - The session token to check
 * @return {boolean} True if user can access settings
 */
function canAccessSettings(sessionToken) {
  return isLevel1(sessionToken);
}

/**
 * Check if user can access rescheduling analytics (Level 1 only)
 * @param {string} sessionToken - The session token to check
 * @return {boolean} True if user can access rescheduling analytics
 */
function canAccessRescheduleAnalytics(sessionToken) {
  return isLevel1(sessionToken);
}

/**
 * Check if user can manage system settings (Level 1 only)
 * @param {string} sessionToken - The session token to check
 * @return {boolean} True if user can manage system settings
 */
function canManageSystemSettings(sessionToken) {
  return isLevel1(sessionToken);
}

/**
 * Get all users from the Login sheet
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Object with success status and users array
 */
function getAllUsers(sessionToken) {
  try {
    // Validate session and check admin access
    const username = getSessionUsername(sessionToken);
    if (!username) {
      return {
        success: false,
        message: "Invalid session. Please login again.",
      };
    }

    if (!hasAccessLevel(sessionToken, 1)) {
      return {
        success: false,
        message: "Admin access required to view users.",
      };
    }

    const ss = SpreadsheetApp.getActive();
    const sheet = ss.getSheetByName("Login");

    if (!sheet) {
      return { success: false, message: "Login sheet not found." };
    }

    const data = sheet.getDataRange().getValues();
    const users = [];

    // Skip header row (index 0)
    for (let i = 1; i < data.length; i++) {
      if (data[i][0]) {
        // Check if username exists
        users.push({
          username: data[i][0],
          role: data[i][2] || "user",
          fullName: data[i][3] || "",
          rowIndex: i + 1, // Store actual row number for updates
        });
      }
    }

    return { success: true, users: users };
  } catch (error) {
    Logger.log("Error in getAllUsers: " + error.toString());
    return {
      success: false,
      message: "Error retrieving users: " + error.toString(),
    };
  }
}

/**
 * Add a new user to the Login sheet
 * @param {Object} userData - Object containing username, password, role, and fullName
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Success status
 */
function addUser(userData, sessionToken) {
  try {
    // Validate session and check admin access
    const username = getSessionUsername(sessionToken);
    if (!username) {
      return {
        success: false,
        message: "Invalid session. Please login again.",
      };
    }

    if (!hasAccessLevel(sessionToken, 1)) {
      return { success: false, message: "Admin access required to add users." };
    }

    // Validate required fields
    if (!userData.username || !userData.password) {
      return { success: false, message: "Username and password are required." };
    }

    const ss = SpreadsheetApp.getActive();
    const sheet = ss.getSheetByName("Login");

    if (!sheet) {
      return { success: false, message: "Login sheet not found." };
    }

    // Check if username already exists
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === userData.username) {
        return { success: false, message: "Username already exists." };
      }
    }

    // Add new user to the next empty row
    const lastRow = sheet.getLastRow();
    const newRow = lastRow + 1;

    sheet.getRange(newRow, 1).setValue(userData.username);
    sheet.getRange(newRow, 2).setValue(userData.password);
    sheet.getRange(newRow, 3).setValue(userData.role || "user");
    sheet.getRange(newRow, 4).setValue(userData.fullName || "");

    // Log audit event
    try {
      logAuditEvent(sessionToken, "USER_CREATED", "USER", userData.username, {
        role: userData.role || "user",
        fullName: userData.fullName || "",
        createdBy: username,
      });
    } catch (auditError) {
      Logger.log("Audit logging failed: " + auditError.toString());
    }

    return { success: true, message: "User added successfully." };
  } catch (error) {
    Logger.log("Error in addUser: " + error.toString());
    return {
      success: false,
      message: "Error adding user: " + error.toString(),
    };
  }
}

/**
 * Update an existing user in the Login sheet
 * @param {Object} userData - Object containing username, role, fullName, and optional newPassword
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Success status
 */
function updateUser(userData, sessionToken) {
  try {
    // Validate session and check admin access
    const currentUsername = getSessionUsername(sessionToken);
    if (!currentUsername) {
      return {
        success: false,
        message: "Invalid session. Please login again.",
      };
    }

    if (!hasAccessLevel(sessionToken, 1)) {
      return {
        success: false,
        message: "Admin access required to update users.",
      };
    }

    // Validate required fields
    if (!userData.username) {
      return { success: false, message: "Username is required." };
    }

    const ss = SpreadsheetApp.getActive();
    const sheet = ss.getSheetByName("Login");

    if (!sheet) {
      return { success: false, message: "Login sheet not found." };
    }

    // Find the user row
    const data = sheet.getDataRange().getValues();
    let userRowIndex = -1;
    let oldData = {};

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === userData.username) {
        userRowIndex = i + 1; // Actual row number
        oldData = {
          role: data[i][2],
          fullName: data[i][3],
        };
        break;
      }
    }

    if (userRowIndex === -1) {
      return { success: false, message: "User not found." };
    }

    // Update user data
    if (userData.role) {
      sheet.getRange(userRowIndex, 3).setValue(userData.role);
    }
    if (userData.fullName !== undefined) {
      sheet.getRange(userRowIndex, 4).setValue(userData.fullName);
    }
    if (userData.newPassword) {
      sheet.getRange(userRowIndex, 2).setValue(userData.newPassword);
    }

    // Log audit event
    try {
      logAuditEvent(sessionToken, "USER_UPDATED", "USER", userData.username, {
        before: oldData,
        after: {
          role: userData.role,
          fullName: userData.fullName,
        },
        updatedBy: currentUsername,
        passwordChanged: !!userData.newPassword,
      });
    } catch (auditError) {
      Logger.log("Audit logging failed: " + auditError.toString());
    }

    return { success: true, message: "User updated successfully." };
  } catch (error) {
    Logger.log("Error in updateUser: " + error.toString());
    return {
      success: false,
      message: "Error updating user: " + error.toString(),
    };
  }
}

/**
 * Delete a user from the Login sheet
 * @param {string} usernameToDelete - Username to delete
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Success status
 */
function deleteUser(usernameToDelete, sessionToken) {
  try {
    // Validate session and check admin access
    const currentUsername = getSessionUsername(sessionToken);
    if (!currentUsername) {
      return {
        success: false,
        message: "Invalid session. Please login again.",
      };
    }

    if (!hasAccessLevel(sessionToken, 1)) {
      return {
        success: false,
        message: "Admin access required to delete users.",
      };
    }

    // Prevent self-deletion
    if (currentUsername === usernameToDelete) {
      return { success: false, message: "You cannot delete your own account." };
    }

    const ss = SpreadsheetApp.getActive();
    const sheet = ss.getSheetByName("Login");

    if (!sheet) {
      return { success: false, message: "Login sheet not found." };
    }

    // Find the user row
    const data = sheet.getDataRange().getValues();
    let userRowIndex = -1;
    let deletedUserData = {};

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === usernameToDelete) {
        userRowIndex = i + 1; // Actual row number
        deletedUserData = {
          username: data[i][0],
          role: data[i][2],
          fullName: data[i][3],
        };
        break;
      }
    }

    if (userRowIndex === -1) {
      return { success: false, message: "User not found." };
    }

    // Delete the row
    sheet.deleteRow(userRowIndex);

    // Log audit event
    try {
      logAuditEvent(sessionToken, "USER_DELETED", "USER", usernameToDelete, {
        deletedUser: deletedUserData,
        deletedBy: currentUsername,
      });
    } catch (auditError) {
      Logger.log("Audit logging failed: " + auditError.toString());
    }

    return { success: true, message: "User deleted successfully." };
  } catch (error) {
    Logger.log("Error in deleteUser: " + error.toString());
    return {
      success: false,
      message: "Error deleting user: " + error.toString(),
    };
  }
}

/**
 * Change a user's password
 * @param {string} targetUsername - Username whose password to change
 * @param {string} newPassword - New password
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Success status
 */
function changeUserPassword(targetUsername, newPassword, sessionToken) {
  try {
    // Validate session
    const currentUsername = getSessionUsername(sessionToken);
    if (!currentUsername) {
      return {
        success: false,
        message: "Invalid session. Please login again.",
      };
    }

    // Allow admins to change any password, or users to change their own
    const isAdmin = hasAccessLevel(sessionToken, 1);
    const isSelf = currentUsername === targetUsername;

    if (!isAdmin && !isSelf) {
      return {
        success: false,
        message: "You can only change your own password.",
      };
    }

    if (!newPassword) {
      return { success: false, message: "New password is required." };
    }

    const ss = SpreadsheetApp.getActive();
    const sheet = ss.getSheetByName("Login");

    if (!sheet) {
      return { success: false, message: "Login sheet not found." };
    }

    // Find the user row
    const data = sheet.getDataRange().getValues();
    let userRowIndex = -1;

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === targetUsername) {
        userRowIndex = i + 1; // Actual row number
        break;
      }
    }

    if (userRowIndex === -1) {
      return { success: false, message: "User not found." };
    }

    // Update password
    sheet.getRange(userRowIndex, 2).setValue(newPassword);

    // Log audit event
    try {
      logAuditEvent(sessionToken, "PASSWORD_CHANGED", "USER", targetUsername, {
        changedBy: currentUsername,
        isSelfChange: isSelf,
      });
    } catch (auditError) {
      Logger.log("Audit logging failed: " + auditError.toString());
    }

    return { success: true, message: "Password changed successfully." };
  } catch (error) {
    Logger.log("Error in changeUserPassword: " + error.toString());
    return {
      success: false,
      message: "Error changing password: " + error.toString(),
    };
  }
}

/**
 * Check if user can book appointments (All levels)
 * @param {string} sessionToken - The session token to check
 * @return {boolean} True if user can book appointments
 */
function canBookAppointments(sessionToken) {
  return hasAccessLevel(sessionToken, 4); // All levels can book
}

/**
 * Check if user can reschedule appointments (Level 1, 2, or 3)
 * @param {string} sessionToken - The session token to check
 * @return {boolean} True if user can reschedule appointments
 */
function canRescheduleAppointments(sessionToken) {
  return hasAccessLevel(sessionToken, 3);
}

/**
 * Check if user can cancel appointments (Level 1, 2, or 3)
 * @param {string} sessionToken - The session token to check
 * @return {boolean} True if user can cancel appointments
 */
function canCancelAppointments(sessionToken) {
  return hasAccessLevel(sessionToken, 3);
}

/**
 * Check if user can confirm appointments (Level 1, 2, or 3)
 * @param {string} sessionToken - The session token to check
 * @return {boolean} True if user can confirm appointments
 */
function canConfirmAppointments(sessionToken) {
  return hasAccessLevel(sessionToken, 3);
}

/**
 * Get all available roles for the system
 * @return {Array} Array of role objects with level and description
 */
function getAvailableRoles() {
  return [
    {
      role: "director",
      level: 1,
      description: "Director - Full system access",
    },
    {
      role: "admin",
      level: 1,
      description: "Administrator - Full system access",
    },
    {
      role: "doctor",
      level: 2,
      description: "Doctor - Medical and patient management",
    },
    {
      role: "manager",
      level: 3,
      description: "Manager - Operational management",
    },
    {
      role: "user",
      level: 4,
      description: "General User - Basic appointment operations",
    },
    {
      role: "staff",
      level: 4,
      description: "Staff - Basic appointment operations",
    },
    {
      role: "receptionist",
      level: 4,
      description: "Receptionist - Basic appointment operations",
    },
    {
      role: "nurse",
      level: 4,
      description: "Nurse - Basic appointment operations",
    },
  ];
}

// ===========================
// SETTINGS MANAGEMENT SYSTEM
// ===========================

/**
 * Initialize SystemSettings sheet if it doesn't exist
 */
function initializeSystemSettingsSheet() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let settingsSheet = ss.getSheetByName("SystemSettings");

    if (!settingsSheet) {
      settingsSheet = ss.insertSheet("SystemSettings");

      // Set headers
      const headers = [
        "DefaultUserRole", // A
        "PasswordPolicy", // B
        "MaxLoginAttempts", // C
        "TwoFactorAuth", // D
        "AuditLogging", // E
        "SessionSecurity", // F
      ];

      settingsSheet.getRange(1, 1, 1, headers.length).setValues([headers]);

      // Set default values in row 2
      const defaults = [
        "user", // DefaultUserRole
        "standard", // PasswordPolicy
        5, // MaxLoginAttempts
        "disabled", // TwoFactorAuth
        "enabled", // AuditLogging
        "standard", // SessionSecurity
      ];

      settingsSheet.getRange(2, 1, 1, defaults.length).setValues([defaults]);

      // Format header row
      const headerRange = settingsSheet.getRange(1, 1, 1, headers.length);
      headerRange.setFontWeight("bold");
      headerRange.setBackground("#4a90e2");
      headerRange.setFontColor("#ffffff");

      settingsSheet.setFrozenRows(1);
      Logger.log("SystemSettings sheet created successfully");
    }

    return true;
  } catch (error) {
    Logger.log("Error initializing SystemSettings sheet: " + error.toString());
    return false;
  }
}

/**
 * Save general settings to generalSettings sheet
 * @param {Object} settings - Settings object containing all general settings
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Success status
 */
function saveGeneralSettings(settings, sessionToken) {
  try {
    // Validate session and check admin access
    const username = getSessionUsername(sessionToken);
    if (!username) {
      return {
        success: false,
        message: "Invalid session. Please login again.",
      };
    }

    if (!hasAccessLevel(sessionToken, 1)) {
      return {
        success: false,
        message: "Admin access required to modify settings.",
      };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("generalSettings");

    if (!sheet) {
      return { success: false, message: "generalSettings sheet not found." };
    }

    // Get current values for audit log
    const before = {
      appointmentInterval: sheet.getRange("P2").getValue(),
      maxAppointmentsPerDay: sheet.getRange("Q2").getValue(),
      sessionTimeout: sheet.getRange("R2").getValue(),
      emailNotifications: sheet.getRange("S2").getValue(),
      confirmationReminders: sheet.getRange("T2").getValue(),
      reminderDays: sheet.getRange("U2").getValue(),
    };

    // Save settings to columns P-U (row 2)
    sheet.getRange("P2").setValue(settings.appointmentInterval || 10);
    sheet.getRange("Q2").setValue(settings.maxAppointmentsPerDay || 50);
    sheet.getRange("R2").setValue(settings.sessionTimeout || 24);
    sheet.getRange("S2").setValue(settings.emailNotifications || "enabled");
    sheet.getRange("T2").setValue(settings.confirmationReminders || "enabled");
    sheet.getRange("U2").setValue(settings.reminderDays || 4);

    // Log audit event for settings change
    try {
      logAuditEvent(
        sessionToken,
        "SETTINGS_CHANGE",
        "SETTINGS",
        "GENERAL_SETTINGS",
        {
          before: before,
          after: settings,
          sheetName: "generalSettings",
        },
      );
    } catch (auditError) {
      Logger.log(
        "Audit logging failed for settings change: " + auditError.toString(),
      );
    }

    return { success: true, message: "General settings saved successfully." };
  } catch (error) {
    Logger.log("Error saving general settings: " + error.toString());
    return {
      success: false,
      message: "Error saving general settings: " + error.toString(),
    };
  }
}

/**
 * Load general settings from generalSettings sheet
 * @return {Object} Settings object or defaults
 */
function loadGeneralSettings() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("generalSettings");

    if (!sheet) {
      return {
        success: false,
        message: "generalSettings sheet not found.",
        settings: getDefaultGeneralSettings(),
      };
    }

    const settings = {
      appointmentInterval: sheet.getRange("P2").getValue() || 10,
      maxAppointmentsPerDay: sheet.getRange("Q2").getValue() || 50,
      sessionTimeout: sheet.getRange("R2").getValue() || 24,
      emailNotifications: sheet.getRange("S2").getValue() || "enabled",
      confirmationReminders: sheet.getRange("T2").getValue() || "enabled",
      reminderDays: sheet.getRange("U2").getValue() || 4,
    };

    return { success: true, settings: settings };
  } catch (error) {
    Logger.log("Error loading general settings: " + error.toString());
    return {
      success: false,
      message: error.toString(),
      settings: getDefaultGeneralSettings(),
    };
  }
}

/**
 * Get default general settings
 * @return {Object} Default settings
 */
function getDefaultGeneralSettings() {
  return {
    appointmentInterval: 10,
    maxAppointmentsPerDay: 50,
    sessionTimeout: 24,
    emailNotifications: "enabled",
    confirmationReminders: "enabled",
    reminderDays: 4,
  };
}

/**
 * Save user management settings to SystemSettings sheet
 * @param {Object} settings - Settings object containing all user settings
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Success status
 */
function saveUserSettings(settings, sessionToken) {
  try {
    // Validate session and check admin access
    const username = getSessionUsername(sessionToken);
    if (!username) {
      return {
        success: false,
        message: "Invalid session. Please login again.",
      };
    }

    if (!hasAccessLevel(sessionToken, 1)) {
      return {
        success: false,
        message: "Admin access required to modify settings.",
      };
    }

    // Initialize SystemSettings sheet if it doesn't exist
    initializeSystemSettingsSheet();

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("SystemSettings");

    if (!sheet) {
      return { success: false, message: "SystemSettings sheet not found." };
    }

    // Get current values for audit log
    const before = {
      defaultUserRole: sheet.getRange("A2").getValue(),
      passwordPolicy: sheet.getRange("B2").getValue(),
      maxLoginAttempts: sheet.getRange("C2").getValue(),
      twoFactorAuth: sheet.getRange("D2").getValue(),
      auditLogging: sheet.getRange("E2").getValue(),
      sessionSecurity: sheet.getRange("F2").getValue(),
    };

    // Save settings to columns A-F (row 2)
    sheet.getRange("A2").setValue(settings.defaultUserRole || "user");
    sheet.getRange("B2").setValue(settings.passwordPolicy || "standard");
    sheet.getRange("C2").setValue(settings.maxLoginAttempts || 5);
    sheet.getRange("D2").setValue(settings.twoFactorAuth || "disabled");
    sheet.getRange("E2").setValue(settings.auditLogging || "enabled");
    sheet.getRange("F2").setValue(settings.sessionSecurity || "standard");

    // Log audit event for settings change
    try {
      logAuditEvent(
        sessionToken,
        "SETTINGS_CHANGE",
        "SETTINGS",
        "USER_SETTINGS",
        {
          before: before,
          after: settings,
          sheetName: "SystemSettings",
        },
      );
    } catch (auditError) {
      Logger.log(
        "Audit logging failed for settings change: " + auditError.toString(),
      );
    }

    return { success: true, message: "User settings saved successfully." };
  } catch (error) {
    Logger.log("Error saving user settings: " + error.toString());
    return {
      success: false,
      message: "Error saving user settings: " + error.toString(),
    };
  }
}

/**
 * Load user settings from SystemSettings sheet
 * @return {Object} Settings object or defaults
 */
function loadUserSettings() {
  try {
    // Initialize sheet if it doesn't exist
    initializeSystemSettingsSheet();

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("SystemSettings");

    if (!sheet) {
      return {
        success: false,
        message: "SystemSettings sheet not found.",
        settings: getDefaultUserSettings(),
      };
    }

    const settings = {
      defaultUserRole: sheet.getRange("A2").getValue() || "user",
      passwordPolicy: sheet.getRange("B2").getValue() || "standard",
      maxLoginAttempts: sheet.getRange("C2").getValue() || 5,
      twoFactorAuth: sheet.getRange("D2").getValue() || "disabled",
      auditLogging: sheet.getRange("E2").getValue() || "enabled",
      sessionSecurity: sheet.getRange("F2").getValue() || "standard",
    };

    return { success: true, settings: settings };
  } catch (error) {
    Logger.log("Error loading user settings: " + error.toString());
    return {
      success: false,
      message: error.toString(),
      settings: getDefaultUserSettings(),
    };
  }
}

/**
 * Get default user settings
 * @return {Object} Default settings
 */
function getDefaultUserSettings() {
  return {
    defaultUserRole: "user",
    passwordPolicy: "standard",
    maxLoginAttempts: 5,
    twoFactorAuth: "disabled",
    auditLogging: "enabled",
    sessionSecurity: "standard",
  };
}

/**
 * Save maintenance settings to generalSettings sheet
 * @param {Object} settings - Settings object containing all maintenance settings
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Success status
 */
function saveMaintenanceSettings(settings, sessionToken) {
  try {
    // Validate session and check admin access
    const username = getSessionUsername(sessionToken);
    if (!username) {
      return {
        success: false,
        message: "Invalid session. Please login again.",
      };
    }

    if (!hasAccessLevel(sessionToken, 1)) {
      return {
        success: false,
        message: "Admin access required to modify settings.",
      };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("generalSettings");

    if (!sheet) {
      return { success: false, message: "generalSettings sheet not found." };
    }

    // Get current values for audit log
    const before = {
      autoBackup: sheet.getRange("V2").getValue(),
      dataRetention: sheet.getRange("W2").getValue(),
      archiveOldData: sheet.getRange("X2").getValue(),
      systemMonitoring: sheet.getRange("Y2").getValue(),
      performanceOptimization: sheet.getRange("Z2").getValue(),
      errorReporting: sheet.getRange("AA2").getValue(),
    };

    // Save settings to columns V-AA (row 2)
    sheet.getRange("V2").setValue(settings.autoBackup || "disabled");
    sheet.getRange("W2").setValue(settings.dataRetention || 24);
    sheet.getRange("X2").setValue(settings.archiveOldData || "disabled");
    sheet.getRange("Y2").setValue(settings.systemMonitoring || "disabled");
    sheet
      .getRange("Z2")
      .setValue(settings.performanceOptimization || "disabled");
    sheet.getRange("AA2").setValue(settings.errorReporting || "enabled");

    // Log audit event for settings change
    try {
      logAuditEvent(
        sessionToken,
        "SETTINGS_CHANGE",
        "SETTINGS",
        "MAINTENANCE_SETTINGS",
        {
          before: before,
          after: settings,
          sheetName: "generalSettings",
        },
      );
    } catch (auditError) {
      Logger.log(
        "Audit logging failed for settings change: " + auditError.toString(),
      );
    }

    return {
      success: true,
      message: "Maintenance settings saved successfully.",
    };
  } catch (error) {
    Logger.log("Error saving maintenance settings: " + error.toString());
    return {
      success: false,
      message: "Error saving maintenance settings: " + error.toString(),
    };
  }
}

/**
 * Load maintenance settings from generalSettings sheet
 * @return {Object} Settings object or defaults
 */
function loadMaintenanceSettings() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("generalSettings");

    if (!sheet) {
      return {
        success: false,
        message: "generalSettings sheet not found.",
        settings: getDefaultMaintenanceSettings(),
      };
    }

    const settings = {
      autoBackup: sheet.getRange("V2").getValue() || "disabled",
      dataRetention: sheet.getRange("W2").getValue() || 24,
      archiveOldData: sheet.getRange("X2").getValue() || "disabled",
      systemMonitoring: sheet.getRange("Y2").getValue() || "disabled",
      performanceOptimization: sheet.getRange("Z2").getValue() || "disabled",
      errorReporting: sheet.getRange("AA2").getValue() || "enabled",
    };

    return { success: true, settings: settings };
  } catch (error) {
    Logger.log("Error loading maintenance settings: " + error.toString());
    return {
      success: false,
      message: error.toString(),
      settings: getDefaultMaintenanceSettings(),
    };
  }
}

/**
 * Get default maintenance settings
 * @return {Object} Default settings
 */
function getDefaultMaintenanceSettings() {
  return {
    autoBackup: "disabled",
    dataRetention: 24,
    archiveOldData: "disabled",
    systemMonitoring: "disabled",
    performanceOptimization: "disabled",
    errorReporting: "enabled",
  };
}

// ===========================
// AUDIT LOGGING SYSTEM
// ===========================

/**
 * Initializes or ensures the AuditLog sheet exists with proper headers.
 * Only protects the sheet when it is first created — protection must NOT be called
 * on every write because each call accumulates a stale protection object in Google
 * Sheets, and removing/re-adding protection becomes exponentially slower over time.
 */
function initializeAuditLogSheet() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let auditSheet = ss.getSheetByName("AuditLog");

    // Create sheet if it doesn't exist
    if (!auditSheet) {
      auditSheet = ss.insertSheet("AuditLog");

      // Set headers
      const headers = [
        "Timestamp", // A: ISO format timestamp
        "Username", // B: User's username
        "FullName", // C: User's full name
        "UserRole", // D: User's role (director, doctor, etc.)
        "ActionType", // E: Type of action performed
        "TargetType", // F: Type of target (PATIENT, APPOINTMENT, etc.)
        "TargetID", // G: ID of the target (MRD, AppointmentID, etc.)
        "Details", // H: JSON string with additional details
        "IPAddress", // I: IP address if available
        "SheetName", // J: Name of sheet affected
      ];

      auditSheet.getRange(1, 1, 1, headers.length).setValues([headers]);

      // Format header row
      const headerRange = auditSheet.getRange(1, 1, 1, headers.length);
      headerRange.setFontWeight("bold");
      headerRange.setBackground("#4a90e2");
      headerRange.setFontColor("#ffffff");

      // Freeze header row
      auditSheet.setFrozenRows(1);

      // Auto-resize columns
      for (let i = 1; i <= headers.length; i++) {
        auditSheet.autoResizeColumn(i);
      }

      Logger.log("AuditLog sheet created successfully");

      // Protect only on first creation
      protectAuditLogSheet(auditSheet);
    }

    return true;
  } catch (error) {
    Logger.log("Error initializing AuditLog sheet: " + error.toString());
    return false;
  }
}

/**
 * Protect AuditLog sheet to prevent tampering (HIPAA compliance requirement).
 * Only call this once during sheet creation — NOT on every write.
 * Repeated protect() calls accumulate stale protection objects and cause severe slowdowns.
 * @param {Sheet} auditSheet - The AuditLog sheet to protect
 */
function protectAuditLogSheet(auditSheet) {
  try {
    // Remove any existing protections first to avoid accumulation
    const existing = auditSheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    existing.forEach(p => p.remove());

    const protection = auditSheet.protect();
    protection.setDescription(
      "Audit log is protected for compliance. Only authorized code can append entries.",
    );

    // Remove all editors - make it truly read-only
    protection.removeEditors(protection.getEditors());

    // Only the script can edit
    protection.setWarningOnly(false);

    Logger.log("AuditLog sheet protected successfully");
  } catch (error) {
    Logger.log("Error protecting AuditLog sheet: " + error.toString());
  }
}

/**
 * Logs an audit event to the AuditLog sheet
 * @param {string} sessionToken - Session token of the user performing the action
 * @param {string} actionType - Type of action (BOOK_APPOINTMENT, CANCEL_APPOINTMENT, etc.)
 * @param {string} targetType - Type of target (PATIENT, APPOINTMENT, SETTINGS, etc.)
 * @param {string} targetId - ID of the target (MRD number, AppointmentID, etc.)
 * @param {Object} details - Additional details about the action (JSON object)
 * @return {Object} Success status
 */
function logAuditEvent(
  sessionToken,
  actionType,
  targetType,
  targetId,
  details,
) {
  try {
    // Ensure sheet exists (will NOT call protectAuditLogSheet on existing sheets)
    initializeAuditLogSheet();

    // Get user information from session
    let username = "SYSTEM";
    let fullName = "System Process";
    let userRole = "system";

    if (sessionToken) {
      const session = getUserSession(sessionToken);
      if (session) {
        username = session.username || "UNKNOWN";
        fullName = session.fullName || "Unknown User";
        userRole = session.role || "unknown";
      }
    }

    // Get timestamp in ISO format
    const timestamp = new Date().toISOString();

    // Attempt to get IP address (may not work in all contexts)
    let ipAddress = "N/A";
    try {
      const activeUser = Session.getActiveUser();
      if (activeUser) {
        ipAddress = Session.getTemporaryActiveUserKey() || "N/A";
      }
    } catch (e) {
      // IP address not available
    }

    // Convert details to JSON string (sanitize sensitive data)
    let detailsJson = "{}";
    if (details && typeof details === "object") {
      // Create a sanitized copy - never log passwords, tokens, or full medical records
      const sanitizedDetails = {};
      for (const key in details) {
        if (
          key.toLowerCase().includes("password") ||
          key.toLowerCase().includes("token") ||
          key.toLowerCase().includes("secret")
        ) {
          sanitizedDetails[key] = "[REDACTED]";
        } else {
          sanitizedDetails[key] = details[key];
        }
      }
      detailsJson = JSON.stringify(sanitizedDetails);
    }

    // Determine sheet name from details
    const sheetName = details.sheetName || "N/A";

    // Append to AuditLog sheet — no unprotect/reprotect cycle.
    // Protection only guards against manual edits; the script owner always has write access.
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const auditSheet = ss.getSheetByName("AuditLog");

    if (!auditSheet) {
      Logger.log("ERROR: AuditLog sheet not found after initialization");
      return { success: false, message: "AuditLog sheet not found" };
    }

    auditSheet.appendRow([
      timestamp,
      username,
      fullName,
      userRole,
      actionType,
      targetType,
      targetId,
      detailsJson,
      ipAddress,
      sheetName,
    ]);

    return { success: true, message: "Audit event logged successfully" };
  } catch (error) {
    Logger.log("Error logging audit event: " + error.toString());
    // Don't fail the main operation if audit logging fails
    return { success: false, message: error.toString() };
  }
}

function logPrintUsage(sessionToken, date, doctor) {
  try {
    var username = getSessionUsername(sessionToken);
    if (!username) return { success: false, error: "Session expired" };
    return logAuditEvent(
      sessionToken,
      'PRINT_REPORT',
      'REPORT',
      date,
      { sheetName: 'N/A', date: date, doctor: doctor }
    );
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Archive old audit logs (>3 years) to AuditLogArchive sheet
 * Implements retention policy for compliance
 */

/**
 * ONE-TIME CLEANUP: Remove accumulated stale AuditLog sheet protections.
 * Run this once from the GAS editor on the OLD spreadsheet to restore fast login/logout.
 * After running, login should drop from ~100s back to ~12s.
 */
function cleanupAuditLogProtections() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const auditSheet = ss.getSheetByName("AuditLog");
    if (!auditSheet) {
      Logger.log("AuditLog sheet not found.");
      return;
    }
    const protections = auditSheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    Logger.log("Found " + protections.length + " protection(s) on AuditLog. Removing all...");
    protections.forEach(p => p.remove());

    // Set exactly one clean protection
    protectAuditLogSheet(auditSheet);
    Logger.log("Done. AuditLog now has exactly 1 protection.");
  } catch (e) {
    Logger.log("cleanupAuditLogProtections error: " + e.toString());
  }
}

function archiveOldAuditLogs() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const auditSheet = ss.getSheetByName("AuditLog");

    if (!auditSheet) {
      return { success: false, message: "AuditLog sheet not found" };
    }

    // Get or create AuditLogArchive sheet
    let archiveSheet = ss.getSheetByName("AuditLogArchive");
    if (!archiveSheet) {
      archiveSheet = ss.insertSheet("AuditLogArchive");
      // Copy headers from AuditLog
      const headers = auditSheet.getRange(1, 1, 1, 10).getValues();
      archiveSheet.getRange(1, 1, 1, 10).setValues(headers);
    }

    // Calculate cutoff date (3 years ago)
    const cutoffDate = new Date();
    cutoffDate.setFullYear(cutoffDate.getFullYear() - 3);

    const data = auditSheet.getDataRange().getValues();
    const headers = data[0];

    let movedCount = 0;
    const rowsToDelete = [];

    // Check each row (skip header)
    for (let i = 1; i < data.length; i++) {
      const timestamp = new Date(data[i][0]); // Column A: Timestamp

      if (timestamp < cutoffDate) {
        // Move to archive
        archiveSheet.appendRow(data[i]);
        rowsToDelete.push(i + 1); // +1 for 1-based indexing
        movedCount++;
      }
    }

    // Delete rows from AuditLog (bottom to top to maintain indices)
    for (let i = rowsToDelete.length - 1; i >= 0; i--) {
      auditSheet.deleteRow(rowsToDelete[i]);
    }

    return {
      success: true,
      message: `Archived ${movedCount} audit log entries`,
      movedCount: movedCount,
    };
  } catch (error) {
    Logger.log("Error archiving old audit logs: " + error.toString());
    return { success: false, message: error.toString() };
  }
}

/**
 * Get audit logs with filtering and pagination
 * @param {Object} filters - Filter criteria (dateFrom, dateTo, username, actionType, targetType)
 * @param {number} limit - Number of records to return (default: 100)
 * @param {number} offset - Number of records to skip (default: 0)
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Object with success status, logs array, and total count
 */
function getAuditLogs(filters, limit, offset, sessionToken) {
  try {
    // Validate session and check Level 1 access
    const username = getSessionUsername(sessionToken);
    if (!username) {
      return {
        success: false,
        message: "Invalid session. Please login again.",
      };
    }

    if (!hasAccessLevel(sessionToken, 1)) {
      return {
        success: false,
        message: "Admin access required to view audit logs.",
      };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const auditSheet = ss.getSheetByName("AuditLog");

    if (!auditSheet) {
      return { success: false, message: "AuditLog sheet not found." };
    }

    const data = auditSheet.getDataRange().getValues();

    if (data.length <= 1) {
      return { success: true, logs: [], totalCount: 0 };
    }

    const headers = data[0];
    let logs = [];

    // Convert rows to objects and apply filters
    for (let i = 1; i < data.length; i++) {
      const row = data[i];

      // Skip empty rows
      if (!row[0]) continue;

      const log = {
        timestamp: row[0],
        username: row[1],
        fullName: row[2],
        userRole: row[3],
        actionType: row[4],
        targetType: row[5],
        targetId: row[6],
        details: row[7],
        ipAddress: row[8],
        sheetName: row[9],
      };

      // Apply filters
      let include = true;

      if (filters) {
        // Date range filter
        if (filters.dateFrom) {
          const logDate = new Date(log.timestamp);
          const fromDate = new Date(filters.dateFrom);
          if (logDate < fromDate) include = false;
        }

        if (filters.dateTo) {
          const logDate = new Date(log.timestamp);
          const toDate = new Date(filters.dateTo);
          toDate.setHours(23, 59, 59, 999); // End of day
          if (logDate > toDate) include = false;
        }

        // Username filter (case-insensitive partial match)
        if (filters.username && include) {
          const filterUsername = filters.username.toLowerCase();
          const logUsername = (log.username || "").toLowerCase();
          const logFullName = (log.fullName || "").toLowerCase();
          if (
            !logUsername.includes(filterUsername) &&
            !logFullName.includes(filterUsername)
          ) {
            include = false;
          }
        }

        // Action type filter
        if (filters.actionType && include) {
          if (log.actionType !== filters.actionType) {
            include = false;
          }
        }

        // Target type filter
        if (filters.targetType && include) {
          if (log.targetType !== filters.targetType) {
            include = false;
          }
        }

        // Search in details (case-insensitive)
        if (filters.searchTerm && include) {
          const searchTerm = filters.searchTerm.toLowerCase();
          const searchableText = [
            log.username,
            log.fullName,
            log.actionType,
            log.targetType,
            log.targetId,
            log.details,
            log.sheetName,
          ]
            .join(" ")
            .toLowerCase();

          if (!searchableText.includes(searchTerm)) {
            include = false;
          }
        }
      }

      if (include) {
        logs.push(log);
      }
    }

    // Sort by timestamp descending (newest first)
    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const totalCount = logs.length;

    // Apply pagination
    const limitNum = limit || 100;
    const offsetNum = offset || 0;
    const paginatedLogs = logs.slice(offsetNum, offsetNum + limitNum);

    return {
      success: true,
      logs: paginatedLogs,
      totalCount: totalCount,
      returnedCount: paginatedLogs.length,
    };
  } catch (error) {
    Logger.log("Error in getAuditLogs: " + error.toString());
    return {
      success: false,
      message: "Error retrieving audit logs: " + error.toString(),
    };
  }
}

/**
 * Get unique action types from audit logs
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Object with success status and array of action types
 */
function getAuditActionTypes(sessionToken) {
  try {
    // Validate session and check Level 1 access
    const username = getSessionUsername(sessionToken);
    if (!username) {
      return {
        success: false,
        message: "Invalid session. Please login again.",
      };
    }

    if (!hasAccessLevel(sessionToken, 1)) {
      return { success: false, message: "Admin access required." };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const auditSheet = ss.getSheetByName("AuditLog");

    if (!auditSheet) {
      return { success: true, actionTypes: [] };
    }

    const data = auditSheet.getDataRange().getValues();
    const actionTypeSet = new Set();

    // Skip header row, column E (index 4) is ActionType
    for (let i = 1; i < data.length; i++) {
      if (data[i][4]) {
        actionTypeSet.add(data[i][4]);
      }
    }

    const actionTypes = Array.from(actionTypeSet).sort();

    return { success: true, actionTypes: actionTypes };
  } catch (error) {
    Logger.log("Error in getAuditActionTypes: " + error.toString());
    return { success: false, message: error.toString() };
  }
}

/**
 * Get unique target types from audit logs
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Object with success status and array of target types
 */
function getAuditTargetTypes(sessionToken) {
  try {
    // Validate session and check Level 1 access
    const username = getSessionUsername(sessionToken);
    if (!username) {
      return {
        success: false,
        message: "Invalid session. Please login again.",
      };
    }

    if (!hasAccessLevel(sessionToken, 1)) {
      return { success: false, message: "Admin access required." };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const auditSheet = ss.getSheetByName("AuditLog");

    if (!auditSheet) {
      return { success: true, targetTypes: [] };
    }

    const data = auditSheet.getDataRange().getValues();
    const targetTypeSet = new Set();

    // Skip header row, column F (index 5) is TargetType
    for (let i = 1; i < data.length; i++) {
      if (data[i][5]) {
        targetTypeSet.add(data[i][5]);
      }
    }

    const targetTypes = Array.from(targetTypeSet).sort();

    return { success: true, targetTypes: targetTypes };
  } catch (error) {
    Logger.log("Error in getAuditTargetTypes: " + error.toString());
    return { success: false, message: error.toString() };
  }
}

/**
 * Check if user can access audit logs (Level 1 only)
 * @param {string} sessionToken - The session token to check
 * @return {boolean} True if user can access audit logs
 */
function canAccessAuditLogs(sessionToken) {
  return isLevel1(sessionToken);
}

// ===========================
// REMARKS HISTORY SYSTEM
// ===========================

/**
 * Initializes or ensures the RemarksHistory sheet exists with proper headers
 */
function initializeRemarksHistorySheet() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let remarksSheet = ss.getSheetByName("RemarksHistory");

    if (!remarksSheet) {
      remarksSheet = ss.insertSheet("RemarksHistory");
      const headers = [
        "AppointmentID",
        "Remark",
        "AddedBy",
        "AddedAt",
        "SequenceNumber",
      ];
      remarksSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      remarksSheet.setFrozenRows(1);
    }

    return remarksSheet;
  } catch (e) {
    throw e;
  }
}

/**
 * Adds a new remark to the history for an appointment
 * @param {string} appointmentId - The appointment ID
 * @param {string} remarkText - The remark text to add
 * @param {string} sessionToken - Session token to identify the user
 * @return {Object} Success/failure response
 */
function addRemarkToHistory(appointmentId, remarkText, sessionToken) {
  try {
    if (!remarkText || remarkText.trim() === "") {
      return { success: false, message: "Remark text cannot be empty" };
    }

    const username = getSessionUsername(sessionToken);
    if (!username) {
      return { success: false, message: "Invalid session" };
    }

    const remarksSheet = initializeRemarksHistorySheet();
    const data = remarksSheet.getDataRange().getValues();

    // Calculate sequence number (count of existing remarks for this appointment + 1)
    let sequenceNumber = 1;
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === appointmentId) {
        sequenceNumber++;
      }
    }

    const now = new Date();
    const newRow = [
      appointmentId,
      remarkText.trim(),
      username,
      now,
      sequenceNumber,
    ];

    remarksSheet.appendRow(newRow);

    // Update the appointment sheet's Remarks column (L) with the latest remark
    updateAppointmentLatestRemark(appointmentId, remarkText.trim());

    // Determine which sheet the appointment is in for proper audit logging
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let targetType = "APPOINTMENT";
    let sheetName = "appointment";
    let patientName = "";
    let mrdNo = "";
    const sheetNames = ["appointment", "cancel", "Archive"];

    for (let name of sheetNames) {
      const sheet = ss.getSheetByName(name);
      if (!sheet) continue;
      const sheetData = sheet.getDataRange().getValues();
      for (let i = 1; i < sheetData.length; i++) {
        if (sheetData[i][0] && sheetData[i][0].toString() === appointmentId) {
          sheetName = name;
          patientName = sheetData[i][4] || "";
          mrdNo = sheetData[i][3] || "";
          if (name === "cancel") {
            targetType = "CANCELLED_APPOINTMENT";
          } else if (name === "Archive") {
            targetType = "ARCHIVED_APPOINTMENT";
          }
          break;
        }
      }
    }

    // Log audit event
    logAuditEvent(
      sessionToken,
      "ADD_REMARK_TO_" + targetType,
      targetType,
      appointmentId,
      {
        sheetName: sheetName,
        remarkText: remarkText.trim(),
        sequenceNumber: sequenceNumber,
        addedBy: username,
        patientName: patientName,
        mrdNo: mrdNo,
      },
    );

    return {
      success: true,
      message: "Remark added successfully",
      remark: {
        text: remarkText.trim(),
        addedBy: username,
        addedAt: Utilities.formatDate(
          now,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd HH:mm:ss",
        ),
        sequenceNumber: sequenceNumber,
      },
    };
  } catch (e) {
    return { success: false, message: "Error adding remark: " + e.toString() };
  }
}

/**
 * Updates the Remarks column (L) in the relevant sheet (appointment, cancel, or Archive) with the latest remark text only
 * @param {string} appointmentId - The appointment ID
 * @param {string} latestRemarkText - The latest remark text
 */
function updateAppointmentLatestRemark(appointmentId, latestRemarkText) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheetNames = ["appointment", "cancel", "Archive"];

    // Search through all relevant sheets
    for (let sheetName of sheetNames) {
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) continue;

      const data = sheet.getDataRange().getValues();
      const headers = data[0];
      const remarksCol = headers.indexOf("Remarks");

      if (remarksCol === -1) continue;

      // Find the appointment row
      for (let i = 1; i < data.length; i++) {
        if (data[i][0] && data[i][0].toString() === appointmentId) {
          sheet.getRange(i + 1, remarksCol + 1).setValue(latestRemarkText);
          return; // Found and updated, exit function
        }
      }
    }
  } catch (e) {}
}

/**
 * Retrieves all remarks history for a specific appointment
 * @param {string} appointmentId - The appointment ID
 * @return {Object} Array of remarks with metadata
 */
function getRemarksHistory(appointmentId) {
  try {
    const remarksSheet = initializeRemarksHistorySheet();
    const data = remarksSheet.getDataRange().getValues();
    const headers = data[0];

    const remarks = [];
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === appointmentId) {
        remarks.push({
          appointmentId: data[i][0],
          text: data[i][1],
          addedBy: data[i][2],
          addedAt: Utilities.formatDate(
            new Date(data[i][3]),
            Session.getScriptTimeZone(),
            "yyyy-MM-dd HH:mm:ss",
          ),
          sequenceNumber: data[i][4],
        });
      }
    }

    // Sort by sequence number (oldest to newest)
    remarks.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    return {
      success: true,
      remarks: remarks,
      count: remarks.length,
    };
  } catch (e) {
    return {
      success: false,
      message: "Error retrieving remarks: " + e.toString(),
      remarks: [],
    };
  }
}

/**
 * Gets only the latest remark for an appointment
 * @param {string} appointmentId - The appointment ID
 * @return {Object} Latest remark or null
 */
function getLatestRemark(appointmentId) {
  try {
    const historyResult = getRemarksHistory(appointmentId);
    if (historyResult.success && historyResult.remarks.length > 0) {
      const latest = historyResult.remarks[historyResult.remarks.length - 1];
      return { success: true, remark: latest };
    }
    return { success: true, remark: null };
  } catch (e) {
    return { success: false, message: e.toString(), remark: null };
  }
}

/**
 * RPC endpoint for adding a remark from the UI
 * @param {string} appointmentId - The appointment ID
 * @param {string} text - The remark text
 * @param {string} sessionToken - Session token
 * @return {Object} Success/failure response
 */
function addRemark(appointmentId, text, sessionToken) {
  return addRemarkToHistory(appointmentId, text, sessionToken);
}

/**
 * Consolidates all remarks from history into a single string (newest to oldest)
 * @param {string} appointmentId - The appointment ID
 * @return {string} Consolidated remarks string (newest to oldest, separated by " | ")
 */
function consolidateRemarks(appointmentId) {
  try {
    const historyResult = getRemarksHistory(appointmentId);

    if (
      !historyResult.success ||
      !historyResult.remarks ||
      historyResult.remarks.length === 0
    ) {
      return ""; // No remarks to consolidate
    }

    // Sort remarks newest to oldest (reverse of the sorted order from getRemarksHistory)
    const remarks = historyResult.remarks.slice().reverse();

    // Consolidate remarks with separators (newest first)
    const consolidated = remarks
      .map((remark, index) => {
        return `[${remark.addedAt}] ${remark.text} (by ${remark.addedBy})`;
      })
      .join(" | ");

    return consolidated;
  } catch (e) {
    return ""; // Return empty string on error, don't fail the archive
  }
}

/**
 * Initializes or ensures the CommentsHistory sheet exists with proper headers
 * Similar to RemarksHistory but for followup appointments using aFollowID
 */
function initializeCommentsHistorySheet() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let commentsSheet = ss.getSheetByName("CommentsHistory");

    if (!commentsSheet) {
      commentsSheet = ss.insertSheet("CommentsHistory");
      const headers = [
        "aFollowID",
        "Comment",
        "AddedBy",
        "AddedAt",
        "SequenceNumber",
      ];
      commentsSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      commentsSheet.setFrozenRows(1);
    }

    return commentsSheet;
  } catch (e) {
    throw e;
  }
}

/**
 * Adds a new comment to the history for a followup appointment
 * @param {string} aFollowID - The followup ID
 * @param {string} commentText - The comment text to add
 * @param {string} sessionToken - Session token to identify the user
 * @return {Object} Success/failure response
 */
function addCommentToHistory(aFollowID, commentText, sessionToken) {
  try {
    if (!commentText || commentText.trim() === "") {
      return { success: false, message: "Comment text cannot be empty" };
    }

    // Validate that comment is not only a date
    const trimmedText = commentText.trim();
    if (isOnlyDatePattern(trimmedText)) {
      return {
        success: false,
        message:
          "Comments cannot be only a date. Please include text with the date (e.g., 'check again on 27/9/25')",
      };
    }

    const username = getSessionUsername(sessionToken);
    if (!username) {
      return { success: false, message: "Invalid session" };
    }

    const commentsSheet = initializeCommentsHistorySheet();
    const data = commentsSheet.getDataRange().getValues();

    // Calculate sequence number (count of existing comments for this followup + 1)
    let sequenceNumber = 1;
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === aFollowID) {
        sequenceNumber++;
      }
    }

    const now = new Date();
    const newRow = [
      aFollowID,
      commentText.trim(),
      username,
      now,
      sequenceNumber,
    ];

    commentsSheet.appendRow(newRow);

    // Update the followup sheet's Comments column (G) with the latest comment
    updateFollowupLatestComment(aFollowID, commentText.trim());

    // Lookup patient data from followup sheet for audit log
    let followupPatientName = "";
    let followupMrdNo = "";
    const followupSheetRef = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("followup");
    if (followupSheetRef) {
      const fData = followupSheetRef.getDataRange().getValues();
      const fHeaders = fData[0];
      const mrdCol = fHeaders.indexOf("MRDNo");
      const nameCol = fHeaders.indexOf("PatientName");
      const fidCol = fHeaders.indexOf("aFollowID");
      for (let i = 1; i < fData.length; i++) {
        if (fData[i][fidCol] && fData[i][fidCol].toString() === aFollowID.toString()) {
          followupPatientName = fData[i][nameCol] || "";
          followupMrdNo = fData[i][mrdCol] || "";
          break;
        }
      }
    }

    // Log audit event
    logAuditEvent(sessionToken, "ADD_FOLLOWUP_COMMENT", "FOLLOWUP", aFollowID, {
      sheetName: "followup",
      commentText: commentText.trim(),
      sequenceNumber: sequenceNumber,
      addedBy: username,
      patientName: followupPatientName,
      mrdNo: followupMrdNo,
    });

    return {
      success: true,
      message: "Comment added successfully",
      comment: {
        text: commentText.trim(),
        addedBy: username,
        addedAt: Utilities.formatDate(
          now,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd HH:mm:ss",
        ),
        sequenceNumber: sequenceNumber,
      },
    };
  } catch (e) {
    return { success: false, message: "Error adding comment: " + e.toString() };
  }
}

/**
 * Check if the text is only a date pattern (no other text)
 * @param {string} text - The text to check
 * @return {boolean} True if text is only a date pattern
 */
function isOnlyDatePattern(text) {
  if (!text || text.trim() === "") {
    return false;
  }

  const trimmedText = text.trim();

  // Common date patterns
  const datePatterns = [
    /^\d{1,2}\/\d{1,2}\/\d{2,4}$/, // DD/MM/YY or DD/MM/YYYY
    /^\d{1,2}-\d{1,2}-\d{2,4}$/, // DD-MM-YY or DD-MM-YYYY
    /^\d{1,2}\.\d{1,2}\.\d{2,4}$/, // DD.MM.YY or DD.MM.YYYY
    /^\d{4}-\d{2}-\d{2}$/, // YYYY-MM-DD
    /^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/, // DD MMM YYYY
    /^[A-Za-z]{3,}\s+\d{1,2},?\s+\d{4}$/, // MMM DD, YYYY or MMM DD YYYY
  ];

  // Check if the entire text matches any date pattern
  for (var i = 0; i < datePatterns.length; i++) {
    if (datePatterns[i].test(trimmedText)) {
      return true;
    }
  }

  return false;
}

/**
 * Updates the Comments column (G) in the followup sheet with the latest comment text only
 * @param {string} aFollowID - The followup ID
 * @param {string} latestCommentText - The latest comment text
 */
function updateFollowupLatestComment(aFollowID, latestCommentText) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const followupSheet = ss.getSheetByName("followup");

    if (!followupSheet) {
      return;
    }

    const data = followupSheet.getDataRange().getValues();
    const headers = data[0];
    const aFollowIDCol = headers.indexOf("aFollowID");
    const commentsCol = headers.indexOf("comments");

    if (aFollowIDCol === -1 || commentsCol === -1) {
      return;
    }

    // Find the followup row
    for (let i = 1; i < data.length; i++) {
      if (
        data[i][aFollowIDCol] &&
        data[i][aFollowIDCol].toString() === aFollowID.toString()
      ) {
        followupSheet
          .getRange(i + 1, commentsCol + 1)
          .setValue(latestCommentText);
        return; // Found and updated, exit function
      }
    }
  } catch (e) {}
}

/**
 * Retrieves all comments history for a specific followup
 * @param {string} aFollowID - The followup ID
 * @return {Object} Array of comments with metadata
 */
function getCommentsHistory(aFollowID) {
  try {
    const commentsSheet = initializeCommentsHistorySheet();
    const data = commentsSheet.getDataRange().getValues();
    const headers = data[0];

    const comments = [];
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === aFollowID) {
        comments.push({
          aFollowID: data[i][0],
          text: data[i][1],
          addedBy: data[i][2],
          addedAt: Utilities.formatDate(
            new Date(data[i][3]),
            Session.getScriptTimeZone(),
            "yyyy-MM-dd HH:mm:ss",
          ),
          sequenceNumber: data[i][4],
        });
      }
    }

    // Sort by sequence number (oldest to newest)
    comments.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    return {
      success: true,
      comments: comments,
      count: comments.length,
    };
  } catch (e) {
    return {
      success: false,
      message: "Error retrieving comments: " + e.toString(),
      comments: [],
    };
  }
}

/**
 * RPC endpoint for adding a comment from the UI
 * @param {string} aFollowID - The followup ID
 * @param {string} text - The comment text
 * @param {string} sessionToken - Session token
 * @return {Object} Success/failure response
 */
function addFollowupComment(aFollowID, text, sessionToken) {
  return addCommentToHistory(aFollowID, text, sessionToken);
}

/**
 * RPC endpoint for getting comments history from the UI
 * @param {string} aFollowID - The followup ID
 * @return {Object} Success/failure response with comments array
 */
function getFollowupCommentsHistory(aFollowID) {
  return getCommentsHistory(aFollowID);
}

/**
 * Gets consolidated remarks from Archive sheet for an appointment
 * @param {string} appointmentId - The appointment ID
 * @return {Object} Success/failure response with remarks text
 */
function getArchivedRemarks(appointmentId) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const archiveSheet = ss.getSheetByName("Archive");

    if (!archiveSheet) {
      return { success: false, message: "Archive sheet not found." };
    }

    const data = archiveSheet.getDataRange().getValues();
    const headers = data[0];
    const remarksCol = headers.indexOf("Remarks");

    if (remarksCol === -1) {
      return {
        success: false,
        message: "Remarks column not found in Archive sheet.",
      };
    }

    // Find the appointment
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] && data[i][0].toString() === appointmentId) {
        const remarks = data[i][remarksCol]
          ? data[i][remarksCol].toString()
          : "";
        return {
          success: true,
          remarks: remarks,
          hasRemarks: remarks.trim() !== "",
        };
      }
    }

    return { success: false, message: "Appointment not found in Archive." };
  } catch (e) {
    return {
      success: false,
      message: "Error retrieving remarks: " + e.toString(),
    };
  }
}

/**
 * Deletes all remarks from RemarksHistory sheet for a given appointment
 * @param {string} appointmentId - The appointment ID
 * @return {boolean} True if successful, false otherwise
 */
function deleteRemarksFromHistory(appointmentId) {
  try {
    const remarksSheet = initializeRemarksHistorySheet();
    const data = remarksSheet.getDataRange().getValues();
    const rowsToDelete = [];

    // Find all rows for this appointment (from bottom to top to maintain indices)
    for (let i = data.length - 1; i >= 1; i--) {
      if (data[i][0] === appointmentId) {
        rowsToDelete.push(i + 1); // +1 because sheet rows are 1-indexed
      }
    }

    // Delete rows from bottom to top to maintain correct indices
    rowsToDelete.forEach((rowNum) => {
      remarksSheet.deleteRow(rowNum);
    });

    return true;
  } catch (e) {
    return false; // Don't fail the archive if deletion fails
  }
}

// ===========================
// END REMARKS HISTORY SYSTEM
// ===========================

// ===========================
// TAG MANAGEMENT SYSTEM
// ===========================

/**
 * Parse tag string from column AF into array
 * @param {string} tagString - The raw tag string from column AF (e.g., "tag1|tag2|tag3")
 * @return {string[]} Array of individual tags
 */
function parseTagString(tagString) {
  try {
    // Handle null, undefined, or empty string
    if (!tagString || tagString.toString().trim() === "") {
      return [];
    }

    // Convert to string and split by pipe delimiter
    const tags = tagString.toString().split("|");

    // Trim whitespace from each tag and filter out empty strings
    const trimmedTags = tags
      .map((tag) => tag.trim())
      .filter((tag) => tag !== "");

    return trimmedTags;
  } catch (e) {
    return [];
  }
}

/**
 * Convert tag array to storage string
 * @param {string[]} tags - Array of tags
 * @return {string} Formatted tag string for storage (e.g., "tag1|tag2|tag3")
 */
function formatTagString(tags) {
  try {
    // Handle null, undefined, or empty array
    if (!tags || !Array.isArray(tags) || tags.length === 0) {
      return "";
    }

    // Filter out empty strings and trim each tag
    const cleanedTags = tags
      .filter((tag) => tag && tag.toString().trim() !== "")
      .map((tag) => tag.toString().trim());

    // Join with pipe delimiter
    return cleanedTags.join("|");
  } catch (e) {
    return "";
  }
}

/**
 * Validate and sanitize a tag
 * @param {string} tag - The tag to validate
 * @return {Object} { valid: boolean, sanitized: string, message: string }
 */
function validateTag(tag) {
  try {
    // Check if tag is null or undefined
    if (tag === null || tag === undefined) {
      return {
        valid: false,
        sanitized: "",
        message: "Tag cannot be null or undefined",
      };
    }

    // Convert to string and trim
    const sanitized = tag.toString().trim();

    // Check if tag is empty or only whitespace
    if (sanitized === "") {
      return {
        valid: false,
        sanitized: "",
        message: "Tag cannot be empty or contain only whitespace",
      };
    }

    // Check maximum length (50 characters as per design)
    const MAX_TAG_LENGTH = 50;
    if (sanitized.length > MAX_TAG_LENGTH) {
      return {
        valid: false,
        sanitized: sanitized,
        message:
          "Tag exceeds maximum length of " + MAX_TAG_LENGTH + " characters",
      };
    }

    // Check for invalid characters (pipe delimiter is not allowed)
    if (sanitized.includes("|")) {
      return {
        valid: false,
        sanitized: sanitized,
        message: "Tag cannot contain the pipe character (|)",
      };
    }

    // Tag is valid
    return {
      valid: true,
      sanitized: sanitized,
      message: "Tag is valid",
    };
  } catch (e) {
    return {
      valid: false,
      sanitized: "",
      message: "Error validating tag: " + e.toString(),
    };
  }
}

/**
 * Get all tags for a specific appointment
 * @param {string} appointmentId - The appointment identifier
 * @param {string} sheetName - The sheet name (appointment, followup, cancel, Archive)
 * @return {Object} { success: boolean, tags: string[], message: string }
 */
function getAppointmentTags(appointmentId, sheetName) {
  try {
    // Validate inputs
    if (!appointmentId || !sheetName) {
      return {
        success: false,
        tags: [],
        message: "AppointmentId and sheetName are required",
      };
    }

    // Get the sheet
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      return {
        success: false,
        tags: [],
        message: "Sheet not found: " + sheetName,
      };
    }

    // Get all data from the sheet
    const data = sheet.getDataRange().getValues();

    if (data.length < 2) {
      return {
        success: false,
        tags: [],
        message: "Sheet is empty",
      };
    }

    // Determine the ID column based on sheet type
    const headers = data[0];
    let idColumnIndex;

    if (sheetName === "followup") {
      idColumnIndex = headers.indexOf("aFollowID");
    } else {
      idColumnIndex = headers.indexOf("AppointmentID");
    }

    if (idColumnIndex === -1) {
      return {
        success: false,
        tags: [],
        message: "ID column not found in sheet",
      };
    }

    // Column AF is index 31 (0-based)
    const TAG_COLUMN_INDEX = 31;

    // Find the appointment row
    for (let i = 1; i < data.length; i++) {
      if (
        data[i][idColumnIndex] &&
        data[i][idColumnIndex].toString() === appointmentId.toString()
      ) {
        // Found the appointment, get tags from column AF
        const tagString = data[i][TAG_COLUMN_INDEX] || "";
        const tags = parseTagString(tagString);

        return {
          success: true,
          tags: tags,
          message: "Tags retrieved successfully",
        };
      }
    }

    // Appointment not found
    return {
      success: false,
      tags: [],
      message: "Appointment not found: " + appointmentId,
    };
  } catch (e) {
    return {
      success: false,
      tags: [],
      message: "Error retrieving tags: " + e.toString(),
    };
  }
}

/**
 * Get all unique tags across a sheet
 * @param {string} sheetName - The sheet name
 * @return {Object} { success: boolean, tags: string[], message: string }
 */
function getAllTagsFromSheet(sheetName) {
  try {
    // Validate input
    if (!sheetName) {
      return {
        success: false,
        tags: [],
        message: "Sheet name is required",
      };
    }

    // Get the sheet
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      return {
        success: false,
        tags: [],
        message: "Sheet not found: " + sheetName,
      };
    }

    // Get all data from the sheet
    const data = sheet.getDataRange().getValues();

    if (data.length < 2) {
      return {
        success: true,
        tags: [],
        message: "Sheet is empty",
      };
    }

    // Column AF is index 31 (0-based)
    const TAG_COLUMN_INDEX = 31;

    // Use a Set to collect unique tags
    const uniqueTags = new Set();

    // Iterate through all rows (skip header row)
    for (let i = 1; i < data.length; i++) {
      const tagString = data[i][TAG_COLUMN_INDEX] || "";
      const tags = parseTagString(tagString);

      // Add each tag to the set
      tags.forEach((tag) => {
        if (tag) {
          uniqueTags.add(tag);
        }
      });
    }

    // Convert Set to Array and sort alphabetically
    const sortedTags = Array.from(uniqueTags).sort((a, b) => {
      return a.toLowerCase().localeCompare(b.toLowerCase());
    });

    return {
      success: true,
      tags: sortedTags,
      message: "Tags retrieved successfully",
    };
  } catch (e) {
    return {
      success: false,
      tags: [],
      message: "Error retrieving tags: " + e.toString(),
    };
  }
}

/**
 * Get all unique tags across all appointment sheets
 * @return {Object} { success: boolean, tags: string[], message: string }
 */
function getAllTags() {
  try {
    // Define the sheets to search
    const sheetNames = ["appointment", "followup", "cancel", "Archive"];

    // Use a Set to collect unique tags from all sheets
    const allUniqueTags = new Set();

    // Iterate through each sheet
    for (let sheetName of sheetNames) {
      const result = getAllTagsFromSheet(sheetName);

      // If successful, add tags to the set
      if (result.success && result.tags) {
        result.tags.forEach((tag) => {
          if (tag) {
            allUniqueTags.add(tag);
          }
        });
      }
      // If sheet doesn't exist or is empty, continue to next sheet
      // Don't fail the entire operation
    }

    // Convert Set to Array and sort alphabetically
    const sortedTags = Array.from(allUniqueTags).sort((a, b) => {
      return a.toLowerCase().localeCompare(b.toLowerCase());
    });

    return {
      success: true,
      tags: sortedTags,
      message: "Tags retrieved successfully from all sheets",
    };
  } catch (e) {
    return {
      success: false,
      tags: [],
      message: "Error retrieving tags: " + e.toString(),
    };
  }
}

/**
 * Add a tag to an appointment
 * @param {string} appointmentId - The appointment identifier
 * @param {string} sheetName - The sheet name
 * @param {string} tag - The tag to add
 * @param {string} sessionToken - User session token
 * @return {Object} { success: boolean, tags: string[], message: string }
 */
function addTagToAppointment(appointmentId, sheetName, tag, sessionToken) {
  try {
    // Validate session token
    const username = getSessionUsername(sessionToken);
    if (!username) {
      return {
        success: false,
        tags: [],
        message: "Invalid session",
      };
    }

    // Validate inputs
    if (!appointmentId || !sheetName || !tag) {
      return {
        success: false,
        tags: [],
        message: "AppointmentId, sheetName, and tag are required",
      };
    }

    // Validate and sanitize tag
    const validation = validateTag(tag);
    if (!validation.valid) {
      return {
        success: false,
        tags: [],
        message: validation.message,
      };
    }

    const sanitizedTag = validation.sanitized;

    // Get the sheet
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      return {
        success: false,
        tags: [],
        message: "Sheet not found: " + sheetName,
      };
    }

    // Get all data from the sheet
    const data = sheet.getDataRange().getValues();

    if (data.length < 2) {
      return {
        success: false,
        tags: [],
        message: "Sheet is empty",
      };
    }

    // Determine the ID column based on sheet type
    const headers = data[0];
    let idColumnIndex;

    if (sheetName === "followup") {
      idColumnIndex = headers.indexOf("aFollowID");
    } else {
      idColumnIndex = headers.indexOf("AppointmentID");
    }

    if (idColumnIndex === -1) {
      return {
        success: false,
        tags: [],
        message: "ID column not found in sheet",
      };
    }

    // Column AF is index 31 (0-based)
    const TAG_COLUMN_INDEX = 31;

    // Find the appointment row
    for (let i = 1; i < data.length; i++) {
      if (
        data[i][idColumnIndex] &&
        data[i][idColumnIndex].toString() === appointmentId.toString()
      ) {
        // Found the appointment, get current tags
        const currentTagString = data[i][TAG_COLUMN_INDEX] || "";
        const currentTags = parseTagString(currentTagString);

        // Check for duplicate tags
        const tagExists = currentTags.some(
          (existingTag) =>
            existingTag.toLowerCase() === sanitizedTag.toLowerCase(),
        );

        if (tagExists) {
          return {
            success: false,
            tags: currentTags,
            message: "Tag already exists",
          };
        }

        // Append new tag to tags array
        currentTags.push(sanitizedTag);

        // Format and write back to column AF
        const newTagString = formatTagString(currentTags);
        sheet.getRange(i + 1, TAG_COLUMN_INDEX + 1).setValue(newTagString);

        logAuditEvent(sessionToken, "ADD_TAG", sheetName === "cancel" ? "CANCELLED_APPOINTMENT" : "APPOINTMENT", appointmentId, { tag: sanitizedTag, sheetName: sheetName });

        return {
          success: true,
          tags: currentTags,
          message: "Tag added successfully",
        };
      }
    }

    // Appointment not found
    return {
      success: false,
      tags: [],
      message: "Appointment not found: " + appointmentId,
    };
  } catch (e) {
    return {
      success: false,
      tags: [],
      message: "Error adding tag: " + e.toString(),
    };
  }
}

/**
 * Remove a tag from an appointment
 * @param {string} appointmentId - The appointment identifier
 * @param {string} sheetName - The sheet name
 * @param {string} tag - The tag to remove
 * @param {string} sessionToken - User session token
 * @return {Object} { success: boolean, tags: string[], message: string }
 */
function removeTagFromAppointment(appointmentId, sheetName, tag, sessionToken) {
  try {
    // Validate session token
    const username = getSessionUsername(sessionToken);
    if (!username) {
      return {
        success: false,
        tags: [],
        message: "Invalid session",
      };
    }

    // Validate inputs
    if (!appointmentId || !sheetName || !tag) {
      return {
        success: false,
        tags: [],
        message: "AppointmentId, sheetName, and tag are required",
      };
    }

    // Get the sheet
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      return {
        success: false,
        tags: [],
        message: "Sheet not found: " + sheetName,
      };
    }

    // Get all data from the sheet
    const data = sheet.getDataRange().getValues();

    if (data.length < 2) {
      return {
        success: false,
        tags: [],
        message: "Sheet is empty",
      };
    }

    // Determine the ID column based on sheet type
    const headers = data[0];
    let idColumnIndex;

    if (sheetName === "followup") {
      idColumnIndex = headers.indexOf("aFollowID");
    } else {
      idColumnIndex = headers.indexOf("AppointmentID");
    }

    if (idColumnIndex === -1) {
      return {
        success: false,
        tags: [],
        message: "ID column not found in sheet",
      };
    }

    // Column AF is index 31 (0-based)
    const TAG_COLUMN_INDEX = 31;

    // Find the appointment row
    for (let i = 1; i < data.length; i++) {
      if (
        data[i][idColumnIndex] &&
        data[i][idColumnIndex].toString() === appointmentId.toString()
      ) {
        // Found the appointment, get current tags
        const currentTagString = data[i][TAG_COLUMN_INDEX] || "";
        const currentTags = parseTagString(currentTagString);

        // Remove specified tag from array (case-insensitive)
        const updatedTags = currentTags.filter(
          (existingTag) => existingTag.toLowerCase() !== tag.toLowerCase(),
        );

        // Format and write back to column AF (empty string if no tags remain)
        const newTagString = formatTagString(updatedTags);
        sheet.getRange(i + 1, TAG_COLUMN_INDEX + 1).setValue(newTagString);

        logAuditEvent(sessionToken, "REMOVE_TAG", sheetName === "cancel" ? "CANCELLED_APPOINTMENT" : "APPOINTMENT", appointmentId, { tag: tag, sheetName: sheetName });

        return {
          success: true,
          tags: updatedTags,
          message: "Tag removed successfully",
        };
      }
    }

    // Appointment not found
    return {
      success: false,
      tags: [],
      message: "Appointment not found: " + appointmentId,
    };
  } catch (e) {
    return {
      success: false,
      tags: [],
      message: "Error removing tag: " + e.toString(),
    };
  }
}

/**
 * Set all tags for an appointment (replaces existing tags)
 * @param {string} appointmentId - The appointment identifier
 * @param {string} sheetName - The sheet name
 * @param {string[]} tags - Array of tags to set
 * @param {string} sessionToken - User session token
 * @return {Object} { success: boolean, tags: string[], message: string }
 */
function setAppointmentTags(appointmentId, sheetName, tags, sessionToken) {
  try {
    // Validate session token
    const username = getSessionUsername(sessionToken);
    if (!username) {
      return {
        success: false,
        tags: [],
        message: "Invalid session",
      };
    }

    // Validate inputs
    if (!appointmentId || !sheetName) {
      return {
        success: false,
        tags: [],
        message: "AppointmentId and sheetName are required",
      };
    }

    // Validate tags array
    if (!tags || !Array.isArray(tags)) {
      return {
        success: false,
        tags: [],
        message: "Tags must be an array",
      };
    }

    // Validate all tags in array
    const validatedTags = [];
    for (let tag of tags) {
      const validation = validateTag(tag);
      if (!validation.valid) {
        return {
          success: false,
          tags: [],
          message: "Invalid tag: " + validation.message,
        };
      }
      validatedTags.push(validation.sanitized);
    }

    // Get the sheet
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      return {
        success: false,
        tags: [],
        message: "Sheet not found: " + sheetName,
      };
    }

    // Get all data from the sheet
    const data = sheet.getDataRange().getValues();

    if (data.length < 2) {
      return {
        success: false,
        tags: [],
        message: "Sheet is empty",
      };
    }

    // Determine the ID column based on sheet type
    const headers = data[0];
    let idColumnIndex;

    if (sheetName === "followup") {
      idColumnIndex = headers.indexOf("aFollowID");
    } else {
      idColumnIndex = headers.indexOf("AppointmentID");
    }

    if (idColumnIndex === -1) {
      return {
        success: false,
        tags: [],
        message: "ID column not found in sheet",
      };
    }

    // Column AF is index 31 (0-based)
    const TAG_COLUMN_INDEX = 31;

    // Find the appointment row
    for (let i = 1; i < data.length; i++) {
      if (
        data[i][idColumnIndex] &&
        data[i][idColumnIndex].toString() === appointmentId.toString()
      ) {
        // Found the appointment, format tags array to string
        const newTagString = formatTagString(validatedTags);

        // Write to column AF in specified sheet
        sheet.getRange(i + 1, TAG_COLUMN_INDEX + 1).setValue(newTagString);

        return {
          success: true,
          tags: validatedTags,
          message: "Tags set successfully",
        };
      }
    }

    // Appointment not found
    return {
      success: false,
      tags: [],
      message: "Appointment not found: " + appointmentId,
    };
  } catch (e) {
    return {
      success: false,
      tags: [],
      message: "Error setting tags: " + e.toString(),
    };
  }
}

/**
 * Copy tags when appointment moves between sheets
 * @param {string} appointmentId - The appointment identifier
 * @param {string} fromSheet - Source sheet name
 * @param {string} toSheet - Destination sheet name
 * @return {Object} { success: boolean, message: string }
 */
function migrateAppointmentTags(appointmentId, fromSheet, toSheet) {
  try {
    // Validate inputs
    if (!appointmentId || !fromSheet || !toSheet) {
      return {
        success: false,
        message: "AppointmentId, fromSheet, and toSheet are required",
      };
    }

    // Get the spreadsheet
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sourceSheet = ss.getSheetByName(fromSheet);
    const destSheet = ss.getSheetByName(toSheet);

    if (!sourceSheet) {
      return {
        success: false,
        message: "Source sheet not found: " + fromSheet,
      };
    }

    if (!destSheet) {
      return {
        success: false,
        message: "Destination sheet not found: " + toSheet,
      };
    }

    // Get tags from source sheet
    const sourceData = sourceSheet.getDataRange().getValues();

    if (sourceData.length < 2) {
      return {
        success: true,
        message: "Source sheet is empty, no tags to migrate",
      };
    }

    // Determine the ID column based on sheet type
    const sourceHeaders = sourceData[0];
    let sourceIdColumnIndex;

    if (fromSheet === "followup") {
      sourceIdColumnIndex = sourceHeaders.indexOf("aFollowID");
    } else {
      sourceIdColumnIndex = sourceHeaders.indexOf("AppointmentID");
    }

    if (sourceIdColumnIndex === -1) {
      return {
        success: false,
        message: "ID column not found in source sheet",
      };
    }

    // Column AF is index 31 (0-based)
    const TAG_COLUMN_INDEX = 31;

    // Find the appointment in source sheet and get tags
    let tagString = "";
    let foundInSource = false;

    for (let i = 1; i < sourceData.length; i++) {
      if (
        sourceData[i][sourceIdColumnIndex] &&
        sourceData[i][sourceIdColumnIndex].toString() ===
          appointmentId.toString()
      ) {
        tagString = sourceData[i][TAG_COLUMN_INDEX] || "";
        foundInSource = true;
        break;
      }
    }

    if (!foundInSource) {
      return {
        success: false,
        message: "Appointment not found in source sheet: " + appointmentId,
      };
    }

    // If no tags to migrate, return success
    if (!tagString || tagString.trim() === "") {
      return {
        success: true,
        message: "No tags to migrate",
      };
    }

    // Get destination sheet data
    const destData = destSheet.getDataRange().getValues();

    if (destData.length < 2) {
      return {
        success: false,
        message: "Destination sheet is empty",
      };
    }

    // Determine the ID column in destination sheet
    const destHeaders = destData[0];
    let destIdColumnIndex;

    if (toSheet === "followup") {
      destIdColumnIndex = destHeaders.indexOf("aFollowID");
    } else {
      destIdColumnIndex = destHeaders.indexOf("AppointmentID");
    }

    if (destIdColumnIndex === -1) {
      return {
        success: false,
        message: "ID column not found in destination sheet",
      };
    }

    // Find the appointment in destination sheet and write tags
    let foundInDest = false;

    for (let i = 1; i < destData.length; i++) {
      if (
        destData[i][destIdColumnIndex] &&
        destData[i][destIdColumnIndex].toString() === appointmentId.toString()
      ) {
        // Found the appointment in destination, write tags to column AF
        destSheet.getRange(i + 1, TAG_COLUMN_INDEX + 1).setValue(tagString);
        foundInDest = true;
        break;
      }
    }

    if (!foundInDest) {
      return {
        success: false,
        message: "Appointment not found in destination sheet: " + appointmentId,
      };
    }

    // Verify successful migration by reading back
    const verifyResult = getAppointmentTags(appointmentId, toSheet);
    if (verifyResult.success) {
      const migratedTags = verifyResult.tags;
      const originalTags = parseTagString(tagString);

      // Compare tags
      if (
        JSON.stringify(migratedTags.sort()) ===
        JSON.stringify(originalTags.sort())
      ) {
        return {
          success: true,
          message: "Tags migrated successfully: " + migratedTags.join(", "),
        };
      } else {
        return {
          success: false,
          message: "Tag migration verification failed",
        };
      }
    } else {
      // Still return success since we wrote the tags, just couldn't verify
      return {
        success: true,
        message:
          "Tags migrated but verification failed: " + verifyResult.message,
      };
    }
  } catch (e) {
    return {
      success: false,
      message: "Error migrating tags: " + e.toString(),
    };
  }
}

// ===========================
// END TAG MANAGEMENT SYSTEM
// ===========================

// ===========================
// PLANNINGB SHEET SYSTEM
// For maxSlots planning and appointment allocation tracking
// ===========================

/**
 * Initializes or ensures the planningB sheet exists with proper structure
 * Headers: Date, maxSlots, NAA, OAA, TAA, RAA, maxSlots edited by, maxSlots edited on, maxSlot edit history
 */
function initializePlanningBSheet() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let planningBSheet = ss.getSheetByName("planningB");

    if (!planningBSheet) {
      planningBSheet = ss.insertSheet("planningB");

      // Set up headers
      const headers = [
        "Date",
        "maxSlots",
        "NAA",
        "OAA",
        "TAA",
        "RAA",
        "maxSlots edited by",
        "maxSlots edited on",
        "maxSlot edit history",
      ];

      planningBSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      planningBSheet.setFrozenRows(1);

      // Format header row
      planningBSheet
        .getRange(1, 1, 1, headers.length)
        .setBackground("#4a90e2")
        .setFontColor("#ffffff")
        .setFontWeight("bold");
    }

    return planningBSheet;
  } catch (e) {
    throw e;
  }
}

/**
 * Calculates NAA, OAA, TAA for a specific date based on appointment sheet
 * NAA = Count of appointments where MRD No (Column D) starts with "N" AND Time Slot has a value
 * OAA = Count of appointments where MRD No (Column D) starts with "S" AND Time Slot has a value
 * TAA = NAA + OAA
 * @param {string} dateStr - Date in "yyyy-MM-dd" format
 * @return {Object} Object with naa, oaa, taa values
 */
function calculateAppointmentStats(dateStr) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentSheet = ss.getSheetByName("appointment");

    if (!appointmentSheet) {
      return { naa: 0, oaa: 0, taa: 0 };
    }

    const data = appointmentSheet.getDataRange().getValues();
    if (data.length <= 1) {
      return { naa: 0, oaa: 0, taa: 0 };
    }

    const headers = data[0];

    const dateCol = headers.indexOf("AppointmentDate");
    const timeSlotCol = headers.indexOf("TimeSlot");
    const mrdCol = headers.indexOf("MRDNo");

    // Also check alternate column names
    const dateColAlt =
      dateCol === -1 ? headers.indexOf("Appointment Date") : dateCol;
    const timeSlotColAlt =
      timeSlotCol === -1 ? headers.indexOf("Time Slot") : timeSlotCol;
    const mrdColAlt = mrdCol === -1 ? headers.indexOf("MRD No") : mrdCol;

    const finalDateCol = dateCol !== -1 ? dateCol : dateColAlt;
    const finalTimeSlotCol = timeSlotCol !== -1 ? timeSlotCol : timeSlotColAlt;
    const finalMrdCol = mrdCol !== -1 ? mrdCol : mrdColAlt;

    // If still not found, use column indices (B=1 for date, C=2 for time slot, D=3 for MRD)
    const useDateCol = finalDateCol !== -1 ? finalDateCol : 1;
    const useTimeSlotCol = finalTimeSlotCol !== -1 ? finalTimeSlotCol : 2;
    const useMrdCol = finalMrdCol !== -1 ? finalMrdCol : 3;

    let naa = 0;
    let oaa = 0;
    let matchedRows = 0;

    for (let i = 1; i < data.length; i++) {
      const row = data[i];

      // Get appointment date
      let appointmentDate = row[useDateCol];
      if (!appointmentDate) continue;

      // Format date for comparison
      let apptDateStr = "";
      if (appointmentDate instanceof Date) {
        apptDateStr = Utilities.formatDate(
          appointmentDate,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd",
        );
      } else {
        apptDateStr = appointmentDate.toString().trim();
        // Handle potential date format issues
        if (apptDateStr.includes("/")) {
          // Convert from MM/DD/YYYY or DD/MM/YYYY format
          const parts = apptDateStr.split("/");
          if (parts.length === 3) {
            // Assume it's a date in some format, try to parse
            const tempDate = new Date(apptDateStr);
            if (!isNaN(tempDate.getTime())) {
              apptDateStr = Utilities.formatDate(
                tempDate,
                Session.getScriptTimeZone(),
                "yyyy-MM-dd",
              );
            }
          }
        }
      }

      // Check if date matches
      if (apptDateStr !== dateStr) continue;

      matchedRows++;

      // Check if time slot has a value
      const timeSlot = row[useTimeSlotCol];
      if (!timeSlot || timeSlot.toString().trim() === "") {
        continue;
      }

      // Get MRD No and check first letter
      const mrdNo = row[useMrdCol];
      if (!mrdNo) {
        continue;
      }

      const mrdStr = mrdNo.toString().trim().toUpperCase();

      if (mrdStr.startsWith("N")) {
        naa++;
      } else if (mrdStr.startsWith("S")) {
        oaa++;
      } else {
      }
    }

    return {
      naa: naa,
      oaa: oaa,
      taa: naa + oaa,
    };
  } catch (e) {
    return { naa: 0, oaa: 0, taa: 0 };
  }
}

/**
 * Updates maxSlots for a specific date and records edit history
 * @param {string} dateStr - Date in "yyyy-MM-dd" format
 * @param {number} maxSlots - Maximum number of slots for the date
 * @param {string} sessionToken - Session token for getting editor info
 * @return {Object} Success/failure response with updated stats
 */
function updateMaxSlots(dateStr, maxSlots, sessionToken) {
  if (!isLevel1(sessionToken)) {
    return {
      success: false,
      accessDenied: true,
      message: "Only Director or Admin can modify Max Slots.",
    };
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const planningBSheet = initializePlanningBSheet();

    // Get editor info
    const editorName =
      getSessionFullName(sessionToken) ||
      getSessionUsername(sessionToken) ||
      "Unknown";
    const editTime = Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone(),
      "yyyy-MM-dd HH:mm:ss",
    );

    // Calculate current stats (TAA = Total Appointments Already booked)
    const stats = calculateAppointmentStats(dateStr);

    // VALIDATION: Don't allow reducing maxSlots below current bookings (TAA)
    if (maxSlots > 0 && maxSlots < stats.taa) {
      return {
        success: false,
        message:
          "Cannot reduce maxSlots below current bookings. " +
          stats.taa +
          " appointments are already booked for this date.",
        data: {
          date: dateStr,
          currentBookings: stats.taa,
          requestedMaxSlots: maxSlots,
        },
      };
    }

    const raa = Math.max(0, maxSlots - stats.taa);

    // Get existing data
    const data = planningBSheet.getDataRange().getValues();

    // Find existing row for this date
    let rowIndex = -1;
    for (let i = 1; i < data.length; i++) {
      let existingDate = data[i][0];
      if (existingDate instanceof Date) {
        existingDate = Utilities.formatDate(
          existingDate,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd",
        );
      } else if (existingDate) {
        existingDate = existingDate.toString().trim();
      }

      if (existingDate === dateStr) {
        rowIndex = i;
        break;
      }
    }

    if (rowIndex !== -1) {
      // Update existing row
      const existingHistory = data[rowIndex][8] || "";
      const newHistoryEntry = `${editorName} set ${maxSlots} on ${editTime}`;
      const updatedHistory = existingHistory
        ? existingHistory + " | " + newHistoryEntry
        : newHistoryEntry;

      // Update all values in the row
      planningBSheet.getRange(rowIndex + 1, 2).setValue(maxSlots); // maxSlots
      planningBSheet.getRange(rowIndex + 1, 3).setValue(stats.naa); // NAA
      planningBSheet.getRange(rowIndex + 1, 4).setValue(stats.oaa); // OAA
      planningBSheet.getRange(rowIndex + 1, 5).setValue(stats.taa); // TAA
      planningBSheet.getRange(rowIndex + 1, 6).setValue(raa); // RAA
      planningBSheet.getRange(rowIndex + 1, 7).setValue(editorName); // maxSlots edited by
      planningBSheet.getRange(rowIndex + 1, 8).setValue(editTime); // maxSlots edited on
      planningBSheet.getRange(rowIndex + 1, 9).setValue(updatedHistory); // maxSlot edit history
    } else {
      // Add new row
      const newHistoryEntry = `${editorName} set ${maxSlots} on ${editTime}`;
      const newRow = [
        dateStr,
        maxSlots,
        stats.naa,
        stats.oaa,
        stats.taa,
        raa,
        editorName,
        editTime,
        newHistoryEntry,
      ];
      planningBSheet.appendRow(newRow);
    }

    // SYNC WITH PLANNINGA: Add or remove date based on maxSlots value
    if (maxSlots > 0) {
      // maxSlots > 0: Ensure date exists in planningA
      ensureDateInPlanningA(dateStr);
    } else {
      // maxSlots = 0: Remove date from planningA
      removeDateFromPlanningA(dateStr);
    }

    logAuditEvent(sessionToken, "UPDATE_MAX_SLOTS", "PLANNING", dateStr, { date: dateStr, maxSlots: maxSlots, taa: stats.taa, sheetName: "planningB" });

    return {
      success: true,
      message: "MaxSlots updated successfully",
      data: {
        date: dateStr,
        maxSlots: maxSlots,
        naa: stats.naa,
        oaa: stats.oaa,
        taa: stats.taa,
        raa: raa,
      },
    };
  } catch (e) {
    return {
      success: false,
      message: "Error updating maxSlots: " + e.toString(),
    };
  }
}

/**
 * Gets planningB data for a specific month
 * @param {number} year - Year
 * @param {number} month - Month (0-11)
 * @return {Object} Object with date as key and planning data as value
 */
function getPlanningBDataForMonth(year, month) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let planningBSheet = ss.getSheetByName("planningB");

    if (!planningBSheet) {
      planningBSheet = initializePlanningBSheet();
    }

    // Check if sheet has any data beyond headers
    const lastRow = planningBSheet.getLastRow();
    if (lastRow <= 1) {
      // Sheet only has headers or is empty
      return { success: true, data: {} };
    }

    const data = planningBSheet.getDataRange().getValues();
    const results = {};

    // Calculate date range for the month (month is 0-indexed)
    const targetMonth = month; // 0-11
    const targetYear = year;

    for (let i = 1; i < data.length; i++) {
      let dateValue = data[i][0];
      if (!dateValue) {
        continue;
      }

      let dateStr = "";
      let rowYear, rowMonth, rowDay;

      if (dateValue instanceof Date) {
        dateStr = Utilities.formatDate(
          dateValue,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd",
        );
        rowYear = dateValue.getFullYear();
        rowMonth = dateValue.getMonth(); // 0-11
        rowDay = dateValue.getDate();
      } else {
        dateStr = dateValue.toString().trim();

        // Try different date formats
        let parsed = false;

        // Format: yyyy-MM-dd
        if (dateStr.match(/^\d{4}-\d{1,2}-\d{1,2}$/)) {
          const parts = dateStr.split("-");
          rowYear = parseInt(parts[0]);
          rowMonth = parseInt(parts[1]) - 1; // Convert to 0-indexed
          rowDay = parseInt(parts[2]);
          parsed = true;
        }
        // Format: MM/dd/yyyy or dd/MM/yyyy
        else if (dateStr.match(/^\d{1,2}\/\d{1,2}\/\d{4}$/)) {
          const parts = dateStr.split("/");
          // Assume MM/dd/yyyy (US format)
          rowMonth = parseInt(parts[0]) - 1;
          rowDay = parseInt(parts[1]);
          rowYear = parseInt(parts[2]);
          parsed = true;
        }
        // Try to parse as Date
        else {
          try {
            const tempDate = new Date(dateStr);
            if (!isNaN(tempDate.getTime())) {
              rowYear = tempDate.getFullYear();
              rowMonth = tempDate.getMonth();
              rowDay = tempDate.getDate();
              parsed = true;
            }
          } catch (e) {}
        }

        if (!parsed) {
          continue;
        }
      }

      // Check if date is in the requested month
      if (rowYear === targetYear && rowMonth === targetMonth) {
        // Convert editedOn to string if it's a Date object (to prevent serialization issues)
        let editedOnValue = data[i][7] || "";
        if (editedOnValue instanceof Date) {
          editedOnValue = Utilities.formatDate(
            editedOnValue,
            Session.getScriptTimeZone(),
            "yyyy-MM-dd HH:mm:ss",
          );
        } else if (editedOnValue) {
          editedOnValue = editedOnValue.toString();
        }

        results[rowDay] = {
          maxSlots: parseInt(data[i][1]) || 0,
          naa: parseInt(data[i][2]) || 0,
          oaa: parseInt(data[i][3]) || 0,
          taa: parseInt(data[i][4]) || 0,
          raa: parseInt(data[i][5]) || 0,
          editedBy: data[i][6] ? data[i][6].toString() : "",
          editedOn: editedOnValue,
        };
      } else {
      }
    }

    // Create a clean return object with only primitive types to avoid serialization issues
    const cleanResults = {};
    for (const day in results) {
      cleanResults[day] = {
        maxSlots: Number(results[day].maxSlots) || 0,
        naa: Number(results[day].naa) || 0,
        oaa: Number(results[day].oaa) || 0,
        taa: Number(results[day].taa) || 0,
        raa: Number(results[day].raa) || 0,
        editedBy: String(results[day].editedBy || ""),
        editedOn: String(results[day].editedOn || ""),
      };
    }

    const returnData = {
      success: true,
      data: cleanResults,
    };
    return returnData;
  } catch (e) {
    return { success: false, message: String(e.toString()), data: {} };
  }
}

/**
 * Updates NAA, OAA, TAA, RAA statistics for a specific date in planningB
 * @param {string} dateStr - Date in "yyyy-MM-dd" format
 * @return {Object} Updated stats
 */
function updatePlanningBStats(dateStr) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let planningBSheet = ss.getSheetByName("planningB");

    if (!planningBSheet) {
      planningBSheet = initializePlanningBSheet();
    }

    // Calculate current stats
    const stats = calculateAppointmentStats(dateStr);

    // Get existing data
    const data = planningBSheet.getDataRange().getValues();

    // Find row for this date
    let rowIndex = -1;
    let currentMaxSlots = 0;

    for (let i = 1; i < data.length; i++) {
      let existingDate = data[i][0];
      if (existingDate instanceof Date) {
        existingDate = Utilities.formatDate(
          existingDate,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd",
        );
      } else if (existingDate) {
        existingDate = existingDate.toString().trim();
      }

      if (existingDate === dateStr) {
        rowIndex = i;
        currentMaxSlots = data[i][1] || 0;
        break;
      }
    }

    if (rowIndex !== -1) {
      // Update existing row stats only (not maxSlots)
      const raa = Math.max(0, currentMaxSlots - stats.taa);

      planningBSheet.getRange(rowIndex + 1, 3).setValue(stats.naa); // NAA
      planningBSheet.getRange(rowIndex + 1, 4).setValue(stats.oaa); // OAA
      planningBSheet.getRange(rowIndex + 1, 5).setValue(stats.taa); // TAA
      planningBSheet.getRange(rowIndex + 1, 6).setValue(raa); // RAA

      return {
        success: true,
        maxSlots: currentMaxSlots,
        naa: stats.naa,
        oaa: stats.oaa,
        taa: stats.taa,
        raa: raa,
      };
    } else {
      // No entry exists for this date yet
      return {
        success: true,
        maxSlots: 0,
        naa: stats.naa,
        oaa: stats.oaa,
        taa: stats.taa,
        raa: 0,
        message: "No maxSlots set for this date",
      };
    }
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

/**
 * Checks if a date has available slots for booking
 * Also checks early booking restrictions based on configured thresholds
 * @param {string} dateStr - Date in "yyyy-MM-dd" format
 * @return {Object} Availability status with maxSlots, RAA values, and early booking restriction status
 */
function checkSlotAvailability(dateStr) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let planningBSheet = ss.getSheetByName("planningB");

    // Get early booking settings (multi-threshold system)
    const settingsResult = getEarlyBookingSettings();
    const allThresholds = settingsResult.thresholds || DEFAULT_THRESHOLDS;

    // Calculate days until appointment
    const daysUntilAppointment = calculateDaysUntil(dateStr);

    // Determine which threshold applies
    const triggeredThreshold = selectThreshold(
      daysUntilAppointment,
      allThresholds,
    );

    // Base response object with all thresholds
    const baseResponse = {
      allThresholds: allThresholds,
      daysUntilAppointment: daysUntilAppointment,
      triggeredThreshold: triggeredThreshold,
    };

    if (!planningBSheet) {
      return {
        ...baseResponse,
        success: true,
        available: false,
        restricted: false,
        maxSlots: 0,
        raa: 0,
        currentTAA: 0,
        percentageUsed: 0,
        message: "No maxSlots set for this date. Booking not allowed.",
      };
    }

    // First update stats to get current values
    const stats = updatePlanningBStats(dateStr);

    if (!stats.success) {
      return {
        ...baseResponse,
        success: false,
        available: false,
        restricted: false,
        currentTAA: 0,
        maxSlots: 0,
        percentageUsed: 0,
        message: stats.message,
      };
    }

    // Calculate TAA percentage (excludes waiting list, uses custom rounding)
    const taaData = calculateTAAPercentage(dateStr);
    const currentTAA = taaData.taa;
    const maxSlots = stats.maxSlots || 0;
    const percentageUsed = taaData.percentageUsed;

    // Check if maxSlots is set (0 or undefined means no restriction applies)
    if (!maxSlots || maxSlots === 0) {
      return {
        ...baseResponse,
        success: true,
        available: false,
        restricted: false,
        maxSlots: 0,
        raa: 0,
        currentTAA: currentTAA,
        percentageUsed: 0,
        naa: stats.naa,
        oaa: stats.oaa,
        taa: stats.taa,
        message: "No maxSlots set for this date. Booking not allowed.",
      };
    }

    // Check multi-threshold early booking restriction:
    // Block if percentageUsed >= applicable threshold percentage
    const isRestricted = percentageUsed >= triggeredThreshold.percentage;

    // Check if slots are available (regular availability check)
    if (stats.raa <= 0) {
      return {
        ...baseResponse,
        success: true,
        available: false,
        restricted: false,
        maxSlots: maxSlots,
        raa: 0,
        currentTAA: currentTAA,
        percentageUsed: percentageUsed,
        naa: stats.naa,
        oaa: stats.oaa,
        taa: stats.taa,
        message:
          "No slots remaining for this date. All " +
          maxSlots +
          " slots are booked.",
      };
    }

    // If early booking restriction applies
    if (isRestricted) {
      // Determine the threshold label
      let thresholdLabel = "";
      if (triggeredThreshold.days >= 10) {
        thresholdLabel = "10+ days";
      } else if (triggeredThreshold.days === 2) {
        thresholdLabel = "2 days";
      } else if (triggeredThreshold.days === 1) {
        thresholdLabel = "1 day";
      } else if (triggeredThreshold.days === 0) {
        thresholdLabel = "Same day";
      } else {
        thresholdLabel = triggeredThreshold.days + " days";
      }

      // Find the next available threshold (lower days value)
      let nextThreshold = null;
      const sortedThresholds = allThresholds
        .slice()
        .sort((a, b) => b.days - a.days);
      for (let i = 0; i < sortedThresholds.length; i++) {
        if (sortedThresholds[i].days < triggeredThreshold.days) {
          nextThreshold = sortedThresholds[i];
          break;
        }
      }

      let guidanceText = "";
      if (nextThreshold) {
        if (nextThreshold.days === 0) {
          guidanceText =
            " Book on the same day to allow " +
            nextThreshold.percentage +
            "% capacity.";
        } else if (nextThreshold.days === 1) {
          guidanceText =
            " Book within 1 day to allow " +
            nextThreshold.percentage +
            "% capacity.";
        } else {
          guidanceText =
            " Book within " +
            nextThreshold.days +
            " days to allow " +
            nextThreshold.percentage +
            "% capacity.";
        }
      }

      const restrictionMessage =
        "Early booking restriction: This date is " +
        daysUntilAppointment +
        " days away (" +
        thresholdLabel +
        " threshold: " +
        triggeredThreshold.percentage +
        "% limit) and " +
        percentageUsed +
        "% of slots are used. " +
        "Current TAA: " +
        currentTAA +
        " / " +
        maxSlots +
        " maxSlots." +
        guidanceText;

      return {
        ...baseResponse,
        success: true,
        available: false,
        restricted: true,
        maxSlots: maxSlots,
        raa: stats.raa,
        currentTAA: currentTAA,
        percentageUsed: percentageUsed,
        naa: stats.naa,
        oaa: stats.oaa,
        taa: stats.taa,
        message: restrictionMessage,
      };
    }

    // No restrictions, slots available
    return {
      ...baseResponse,
      success: true,
      available: true,
      restricted: false,
      maxSlots: maxSlots,
      raa: stats.raa,
      currentTAA: currentTAA,
      percentageUsed: percentageUsed,
      naa: stats.naa,
      oaa: stats.oaa,
      taa: stats.taa,
      message: stats.raa + " slots remaining out of " + maxSlots,
    };
  } catch (e) {
    return {
      success: false,
      available: false,
      restricted: false,
      currentTAA: 0,
      maxSlots: 0,
      percentageUsed: 0,
      daysUntilAppointment: 0,
      allThresholds: DEFAULT_THRESHOLDS,
      triggeredThreshold: DEFAULT_THRESHOLDS[0],
      message: "Error checking availability: " + e.toString(),
    };
  }
}

/**
 * Gets the current slot status for a date (for saving with appointments)
 * @param {string} dateStr - Date in "yyyy-MM-dd" format
 * @return {Object} Current slot status
 */
function getSlotStatusForDate(dateStr) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let planningBSheet = ss.getSheetByName("planningB");

    if (!planningBSheet) {
      const stats = calculateAppointmentStats(dateStr);
      return {
        maxSlots: 0,
        naa: stats.naa,
        oaa: stats.oaa,
        taa: stats.taa,
        raa: 0,
      };
    }

    const data = planningBSheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      let existingDate = data[i][0];
      if (existingDate instanceof Date) {
        existingDate = Utilities.formatDate(
          existingDate,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd",
        );
      } else if (existingDate) {
        existingDate = existingDate.toString().trim();
      }

      if (existingDate === dateStr) {
        return {
          maxSlots: data[i][1] || 0,
          naa: data[i][2] || 0,
          oaa: data[i][3] || 0,
          taa: data[i][4] || 0,
          raa: data[i][5] || 0,
        };
      }
    }

    // No entry found, calculate current stats
    const stats = calculateAppointmentStats(dateStr);
    return {
      maxSlots: 0,
      naa: stats.naa,
      oaa: stats.oaa,
      taa: stats.taa,
      raa: 0,
    };
  } catch (e) {
    return { maxSlots: 0, naa: 0, oaa: 0, taa: 0, raa: 0 };
  }
}

// ===========================
// END PLANNINGB SHEET SYSTEM
// ===========================

/**
 * Retrieves appointments for the given date.
 * Expects date in "YYYY-MM-DD" format.
 * Optionally filters by doctor name.
 * Returns an array of appointment objects.
 */
function getAppointmentsForDay(dateString, doctor) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("appointment");
  if (!sheet) {
    throw new Error("Appointment sheet not found.");
  }
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var results = [];

  // Find the index of the Fixed Slot column (ensure case-insensitive comparison)
  var fixedSlotIndex = -1;
  for (var i = 0; i < headers.length; i++) {
    if (
      headers[i] &&
      typeof headers[i] === "string" &&
      headers[i].toLowerCase() === "fixed slot"
    ) {
      fixedSlotIndex = i;
      break;
    }
  }

  // Find the index of the PatientType column (ensure case-insensitive comparison)
  var patientTypeIndex = -1;
  for (var i = 0; i < headers.length; i++) {
    if (
      headers[i] &&
      typeof headers[i] === "string" &&
      headers[i].toLowerCase() === "patienttype"
    ) {
      patientTypeIndex = i;
      break;
    }
  }

  // Find the index of the Family Identifier column (ensure case-insensitive comparison)
  var familyIdentifierIndex = -1;
  for (var i = 0; i < headers.length; i++) {
    if (
      headers[i] &&
      typeof headers[i] === "string" &&
      headers[i].toLowerCase() === "family identifier"
    ) {
      familyIdentifierIndex = i;
      break;
    }
  }

  // Find the index of the Consult Start column (ensure case-insensitive comparison)
  var consultStartIndex = -1;
  for (var i = 0; i < headers.length; i++) {
    if (
      headers[i] &&
      typeof headers[i] === "string" &&
      headers[i].toLowerCase() === "consult start"
    ) {
      consultStartIndex = i;
      break;
    }
  }

  // Find the index of the Doctor column (ensure case-insensitive comparison)
  var doctorIndex = -1;
  for (var i = 0; i < headers.length; i++) {
    if (
      headers[i] &&
      typeof headers[i] === "string" &&
      headers[i].toLowerCase() === "doctor"
    ) {
      doctorIndex = i;
      break;
    }
  }

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var formattedDate = Utilities.formatDate(
      new Date(row[1]),
      Session.getScriptTimeZone(),
      "yyyy-MM-dd",
    );

    // Filter by doctor if specified
    if (doctor && doctorIndex !== -1 && row[doctorIndex] !== doctor) {
      continue;
    }

    if (formattedDate === dateString) {
      var appointment = {};
      for (var j = 0; j < headers.length; j++) {
        appointment[headers[j]] = row[j].toString(); // Pass all values as strings
      }

      // Ensure FixedSlot property is set regardless of header case
      if (fixedSlotIndex !== -1) {
        appointment["FixedSlot"] = row[fixedSlotIndex].toString();
      }

      // Ensure PatientType property is set regardless of header case
      if (patientTypeIndex !== -1) {
        appointment["PatientType"] = row[patientTypeIndex].toString();
      }

      // Ensure Family Identifier property is set regardless of header case
      if (familyIdentifierIndex !== -1) {
        appointment["Family Identifier"] =
          row[familyIdentifierIndex].toString();
      }

      // Ensure Consult Start property is set regardless of header case
      if (consultStartIndex !== -1) {
        appointment["Consult Start"] = row[consultStartIndex].toString();
      }

      results.push(appointment);
    }
  }

  return results;
}

/**
 * Finds the next date (starting from startDate) that has at least one appointment for the specified doctor.
 * @param {string} startDateStr - Starting date in "YYYY-MM-DD" format
 * @param {string} doctor - Doctor name to filter by
 * @param {number} maxDaysToSearch - Maximum number of days to search ahead (default 30)
 * @returns {object} { success: true, date: "YYYY-MM-DD", hasAppointments: true/false }
 */
function getNextDayWithAppointments(startDateStr, doctor, maxDaysToSearch) {
  try {
    maxDaysToSearch = maxDaysToSearch || 30;

    for (var i = 0; i < maxDaysToSearch; i++) {
      var date = new Date(startDateStr);
      date.setDate(date.getDate() + i);
      var dateStr = Utilities.formatDate(
        date,
        Session.getScriptTimeZone(),
        "yyyy-MM-dd",
      );

      var appointments = getAppointmentsForDay(dateStr, doctor);
      if (appointments && appointments.length > 0) {
        return { success: true, date: dateStr, hasAppointments: true };
      }
    }

    // No appointments found in the search window, return the start date
    return { success: true, date: startDateStr, hasAppointments: false };
  } catch (error) {
    return {
      success: false,
      message: error.toString(),
      date: startDateStr,
      hasAppointments: false,
    };
  }
}

function confirmAppointment4Day(appointmentId, sessionToken) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("appointment");
    if (!sheet) {
      return { success: false, message: "Sheet not found." };
    }

    var data = sheet.getDataRange().getValues();
    var headers = data[0];
    var appointmentRow = null;
    var rowIndex = -1;

    // Find the appointment row
    for (var i = 1; i < data.length; i++) {
      if (data[i][0].toString() === appointmentId) {
        appointmentRow = data[i];
        rowIndex = i;
        break;
      }
    }

    if (!appointmentRow) {
      return { success: false, message: "Appointment not found." };
    }

    // Check for pre-existing 4-day confirmation
    var fourDayConfirmDateCol = headers.indexOf("FourDayConfirmDate");
    var fourDayConfirmByCol = headers.indexOf("FourDayConfirmBy");

    if (fourDayConfirmDateCol === -1 || fourDayConfirmByCol === -1) {
      return { success: false, message: "Confirmation columns not found." };
    }

    if (
      appointmentRow[fourDayConfirmDateCol] &&
      appointmentRow[fourDayConfirmByCol]
    ) {
      return { success: false, message: "4-Day Confirmation already done." };
    }

    var apptDate = new Date(appointmentRow[1]);
    if (isNaN(apptDate.getTime())) {
      return { success: false, message: "Invalid appointment date." };
    }

    var today = new Date();
    var sevenDaysBefore = new Date(apptDate);
    sevenDaysBefore.setDate(apptDate.getDate() - 7);

    var formattedApptDate = Utilities.formatDate(
      apptDate,
      Session.getScriptTimeZone(),
      "yyyy-MM-dd",
    );
    var formattedSevenDaysBefore = Utilities.formatDate(
      sevenDaysBefore,
      Session.getScriptTimeZone(),
      "yyyy-MM-dd",
    );
    var formattedToday = Utilities.formatDate(
      today,
      Session.getScriptTimeZone(),
      "yyyy-MM-dd",
    );

    // Allow confirmation within 7 days before the appointment, including the appointment day

    if (
      formattedToday >= formattedSevenDaysBefore &&
      formattedToday <= formattedApptDate
    ) {
      var user = getSessionUsername(sessionToken);
      var todayFormatted = Utilities.formatDate(
        today,
        Session.getScriptTimeZone(),
        "yyyy-MM-dd",
      );

      sheet
        .getRange(rowIndex + 1, fourDayConfirmDateCol + 1)
        .setValue(todayFormatted);
      sheet.getRange(rowIndex + 1, fourDayConfirmByCol + 1).setValue(user);

      logAuditEvent(sessionToken, "CONFIRM_APPOINTMENT_4DAY", "APPOINTMENT", appointmentId, { confirmationDate: todayFormatted, confirmedBy: user, sheetName: "appointment" });

      return {
        success: true,
        message: "4-Day confirmation successful.",
        confirmationDate: todayFormatted,
        confirmedBy: user,
      };
    } else {
      return {
        success: false,
        message:
          "Confirmation is not allowed at this time. It must be within 7 days before the appointment.",
      };
    }
  } catch (e) {
    return {
      success: false,
      message: "An error occurred during confirmation.",
    };
  }
}

function confirmAppointment1Day(appointmentId, sessionToken) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("appointment");
    var data = sheet.getDataRange().getValues();
    var headers = data[0];
    var appointmentRow = null;
    var rowIndex = -1;

    for (var i = 1; i < data.length; i++) {
      if (data[i][0].toString() === appointmentId) {
        appointmentRow = data[i];
        rowIndex = i;
        break;
      }
    }

    if (!appointmentRow) {
      return { success: false, message: "Appointment not found." };
    }

    //Check for pre-existing 1-day confirmation
    if (
      appointmentRow[headers.indexOf("OneDayConfirmDate")] &&
      appointmentRow[headers.indexOf("OneDayConfirmBy")]
    ) {
      return { success: false, message: "1-Day Confirmation already done." };
    }

    var apptDate = new Date(appointmentRow[1]);
    var formattedApptDate = Utilities.formatDate(
      apptDate,
      Session.getScriptTimeZone(),
      "yyyy-MM-dd",
    );
    var today = new Date();
    var threeDaysBefore = new Date(apptDate);
    threeDaysBefore.setDate(apptDate.getDate() - 3);
    var formattedThreeDaysBefore = Utilities.formatDate(
      threeDaysBefore,
      Session.getScriptTimeZone(),
      "yyyy-MM-dd",
    );
    var formattedToday = Utilities.formatDate(
      today,
      Session.getScriptTimeZone(),
      "yyyy-MM-dd",
    );

    // Allow confirmation within 3 days before the appointment, including the appointment day
    if (
      formattedToday >= formattedThreeDaysBefore &&
      formattedToday <= formattedApptDate
    ) {
      var oneDayConfirmDateCol = headers.indexOf("OneDayConfirmDate");
      var oneDayConfirmByCol = headers.indexOf("OneDayConfirmBy");
      var user = getSessionUsername(sessionToken);
      var todayFormatted = Utilities.formatDate(
        today,
        Session.getScriptTimeZone(),
        "yyyy-MM-dd",
      );

      if (oneDayConfirmDateCol !== -1 && oneDayConfirmByCol !== -1) {
        sheet
          .getRange(rowIndex + 1, oneDayConfirmDateCol + 1)
          .setValue(todayFormatted);
        sheet.getRange(rowIndex + 1, oneDayConfirmByCol + 1).setValue(user);
      } else {
        return { success: false, message: "Confirmation columns not found." };
      }

      logAuditEvent(sessionToken, "CONFIRM_APPOINTMENT_1DAY", "APPOINTMENT", appointmentId, { confirmationDate: todayFormatted, confirmedBy: user, sheetName: "appointment" });

      return {
        success: true,
        message: "1-Day confirmation successful.",
        confirmationDate: todayFormatted,
        confirmedBy: user,
      };
    } else {
      return {
        success: false,
        message:
          "Confirmation is not allowed at this time. It must be within 3 days before the appointment or on the appointment day.",
      };
    }
  } catch (e) {
    return {
      success: false,
      message: "An error occurred during confirmation.",
    };
  }
}

// ... (Your existing code: doGet, include, validateLogin, createSession, getSessionUsername, clearSession, getAppointmentsForDay, confirmAppointment4Day, confirmAppointment1Day) ...

function getAppointmentsForMonth(year, month, doctor) {
  try {
    // Convert month index to month name for logging
    const monthNames = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    const monthName = monthNames[month];

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("appointment");
    if (!sheet) {
      throw new Error("Appointment sheet not found.");
    }

    var data = sheet.getDataRange().getValues();
    var results = {};

    // Column indices (0-based)
    var appointmentDateCol = 1; // Column B (AppointmentDate)
    var mrdCol = 3; // Column D (MRDNo)
    var appointmentTypeCol = 8; // Column I (AppointmentType)
    var doctorCol = 9; // Column J (Doctor)

    for (var i = 1; i < data.length; i++) {
      // Start from row 1 to skip header
      var row = data[i];
      var appointmentDate = new Date(row[appointmentDateCol]);
      if (isNaN(appointmentDate.getTime())) {
        continue; // Skip invalid dates
      }

      // Filter by doctor if provided
      if (doctor && row[doctorCol] !== doctor) {
        continue;
      }

      if (
        appointmentDate.getFullYear() === year &&
        appointmentDate.getMonth() === month
      ) {
        var day = appointmentDate.getDate();
        if (!results[day]) {
          results[day] = { NEW: 0, OLD: 0 };
        }

        var mrd = row[mrdCol].toString();
        if (mrd.startsWith("N")) {
          results[day].NEW++; // Increment NEW count
        } else if (mrd.startsWith("S")) {
          results[day].OLD++; // Increment OLD count
        }

        var appointmentType = row[appointmentTypeCol].toString();
        if (!results[day][appointmentType]) {
          results[day][appointmentType] = 0;
        }
        results[day][appointmentType]++;
      }
    }

    return results;
  } catch (e) {
    return { error: e.toString() };
  }
}

function getAvailableSlotsCount() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentsSheet = ss.getSheetByName("appointment");
    const doctorAvailabilitySheet = ss.getSheetByName("DoctorAvailability");

    if (!appointmentsSheet || !doctorAvailabilitySheet) {
      return { count: 0, trend: 0 };
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get day of week (0 = Sunday, 1 = Monday, etc.)
    const dayOfWeek = today.getDay();
    const dayNames = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    const todayName = dayNames[dayOfWeek];

    // Get booked slots for today
    const appointmentData = appointmentsSheet.getDataRange().getValues();
    const bookedSlots = new Set();

    // Count booked slots for today
    for (let i = 1; i < appointmentData.length; i++) {
      const appointmentDate = new Date(appointmentData[i][1]); // Column B is appointment date
      appointmentDate.setHours(0, 0, 0, 0);

      if (appointmentDate.getTime() === today.getTime()) {
        const timeSlot = appointmentData[i][2]; // Column C is time slot
        bookedSlots.add(timeSlot);
      }
    }

    // Get doctor availability for today
    const availabilityData = doctorAvailabilitySheet.getDataRange().getValues();
    const headers = availabilityData[0];
    const dayColumnIndex = headers.indexOf(todayName);

    if (dayColumnIndex === -1) {
      return { count: 0, trend: 0 };
    }

    // Calculate total available minutes for all doctors
    let totalAvailableMinutes = 0;

    for (let i = 1; i < availabilityData.length; i++) {
      const doctor = availabilityData[i][0]; // Column A is doctor name
      const availabilityRanges = availabilityData[i][dayColumnIndex];

      if (!availabilityRanges) continue;

      // Parse availability ranges and calculate total minutes
      const ranges = availabilityRanges
        .toString()
        .split(",")
        .map((r) => r.trim());

      for (const range of ranges) {
        const [startTime, endTime] = range.split("-");
        if (!startTime || !endTime) continue;

        const startMinutes = timeStringToMinutes(startTime);
        const endMinutes = timeStringToMinutes(endTime);

        if (
          !isNaN(startMinutes) &&
          !isNaN(endMinutes) &&
          endMinutes > startMinutes
        ) {
          totalAvailableMinutes += endMinutes - startMinutes;
        }
      }
    }

    // Calculate total slots based on 10-minute intervals
    const slotInterval = 10; // Same as in bookAppointment page
    const totalPossibleSlots = Math.floor(totalAvailableMinutes / slotInterval);

    // Subtract booked slots
    const availableSlots = totalPossibleSlots - bookedSlots.size;

    return {
      count: availableSlots > 0 ? availableSlots : 0,
      trend: 0, // No trend for available slots
    };
  } catch (error) {
    return { count: 0, trend: 0 };
  }
}

/**
 * Gets today's slot status (maxSlots, NAA, OAA, TAA, RAA) for dashboard
 * @return {Object} Slot status data for today
 */
function getTodaySlotStatus() {
  try {
    const today = new Date();
    const todayStr = Utilities.formatDate(
      today,
      Session.getScriptTimeZone(),
      "yyyy-MM-dd",
    );
    return getSlotStatusForDate(todayStr);
  } catch (error) {
    return { maxSlots: 0, naa: 0, oaa: 0, taa: 0, raa: 0 };
  }
}
/*function getAvailableSlotsCount() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const appointmentsSheet = ss.getSheetByName("appointment");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const data = appointmentsSheet.getDataRange().getValues();
  const bookedSlots = new Set();
  
  // Count booked slots for today
  for (let i = 1; i < data.length; i++) {
    const appointmentDate = new Date(data[i][1]); // Column B is appointment date
    appointmentDate.setHours(0, 0, 0, 0);
    
    if (appointmentDate.getTime() === today.getTime()) {
      const timeSlot = data[i][2]; // Column C is time slot
      bookedSlots.add(timeSlot);
    }
  }
  
  // Get total available slots from general settings
  const generalSettingsSheet = ss.getSheetByName("generalSettings");
  const settingsData = generalSettingsSheet.getDataRange().getValues();
  const totalSlots = settingsData[1][3]; // Assuming total slots are stored in cell D2
  
  return {
    count: totalSlots - bookedSlots.size,
    trend: 0 // No trend for available slots
  };
}
*/

// Book appointment form, MRD No
function getPatientDetailsByMRD(mrdNo, sessionToken) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var patientMasterSheet = ss.getSheetByName("patientMaster");
    var tempPatientMasterSheet = ss.getSheetByName("tempPatientMaster");

    if (!patientMasterSheet && !tempPatientMasterSheet) {
      return { success: false, message: "Patient sheets not found." };
    }
    // Normalize the MRD number
    mrdNo = mrdNo.trim();

    // If it's just a number, add SPD prefix
    if (/^\d+$/.test(mrdNo)) {
      mrdNo = "SPD" + mrdNo;
    }
    // If it starts with SPD but has no numbers after, add the number
    else if (/^SPD$/i.test(mrdNo)) {
      mrdNo = "SPD0";
    }
    // If it starts with SPD and has numbers, ensure proper format
    else if (/^SPD/i.test(mrdNo)) {
      // Extract the number part
      var numPart = mrdNo.replace(/^SPD/i, "");
      if (/^\d+$/.test(numPart)) {
        mrdNo = "SPD" + numPart;
      }
    }

    // Helper function to calculate exact age difference
    function calculateExactAge(dob) {
      var today = new Date();
      var birthDate = new Date(dob);

      // Calculate difference in milliseconds
      var diffInMs = today.getTime() - birthDate.getTime();
      var diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));

      if (diffInDays < 30) {
        // Less than 30 days - return in days
        return diffInDays + " days";
      } else if (diffInDays < 365) {
        // 30 days or more but less than a year - return in months
        var months = Math.floor(diffInDays / 30);
        return months + " months";
      } else {
        // A year or more - return in years
        var years = Math.floor(diffInDays / 365);
        return years + " years";
      }
    }

    // Function to search in patientMaster sheet (with new structure)
    function searchInPatientMaster(sheet) {
      if (!sheet) return null;
      try {
        var data = sheet.getDataRange().getValues();
        if (data.length < 2) return null; // No data rows

        for (var i = 1; i < data.length; i++) {
          var row = data[i];
          if (!row || row.length === 0) continue;

          var currentMRD =
            row[0] !== undefined && row[0] !== null
              ? row[0].toString().trim().toUpperCase()
              : "";

          if (currentMRD === mrdNo.toUpperCase()) {
            // Handle DOB - column 2
            var dob = null;
            var exactAge = "";
            var dobFormatted = "";
            try {
              if (row.length > 2 && row[2]) {
                dob = new Date(row[2]);
                if (!isNaN(dob.getTime())) {
                  exactAge = calculateExactAge(dob);
                  try {
                    var timeZone = Session.getScriptTimeZone();
                    dobFormatted = Utilities.formatDate(
                      dob,
                      timeZone,
                      "yyyy-MM-dd",
                    );
                  } catch (tzError) {
                    // Fallback to simple date formatting
                    var year = dob.getFullYear();
                    var month = String(dob.getMonth() + 1).padStart(2, "0");
                    var day = String(dob.getDate()).padStart(2, "0");
                    dobFormatted = year + "-" + month + "-" + day;
                  }
                }
              }
            } catch (e) {}

            return {
              MRDNo:
                row[0] !== undefined && row[0] !== null
                  ? row[0].toString()
                  : "",
              Name:
                row.length > 1 && row[1] !== undefined && row[1] !== null
                  ? row[1].toString()
                  : "",
              DOB: dobFormatted,
              Age: exactAge,
              Gender:
                row.length > 3 && row[3] !== undefined && row[3] !== null
                  ? row[3].toString()
                  : "",
              Phone:
                row.length > 4 && row[4] !== undefined && row[4] !== null
                  ? row[4].toString()
                  : "",
              Address:
                row.length > 5 && row[5] !== undefined && row[5] !== null
                  ? row[5].toString()
                  : "",
              HomeNo:
                row.length > 6 && row[6] !== undefined && row[6] !== null
                  ? row[6].toString()
                  : "",
              WorkNo:
                row.length > 7 && row[7] !== undefined && row[7] !== null
                  ? row[7].toString()
                  : "",
              RegisteredOn:
                row.length > 8 && row[8] !== undefined && row[8] !== null
                  ? row[8].toString()
                  : "",
              Type:
                row.length > 9 && row[9] !== undefined && row[9] !== null
                  ? row[9].toString()
                  : "",
              AdditionalInfo:
                row.length > 10 && row[10] !== undefined && row[10] !== null
                  ? row[10].toString()
                  : "",
              Status:
                row.length > 11 && row[11] !== undefined && row[11] !== null
                  ? row[11].toString()
                  : "",
            };
          }
        }
      } catch (e) {}
      return null;
    }

    // Function to search in tempPatientMaster sheet (different structure)
    function searchInTempPatientMaster(sheet) {
      if (!sheet) return null;
      try {
        var data = sheet.getDataRange().getValues();
        if (data.length < 2) return null; // No data rows

        for (var i = 1; i < data.length; i++) {
          var row = data[i];
          if (!row || row.length === 0) continue;

          var currentMRD =
            row[0] !== undefined && row[0] !== null
              ? row[0].toString().trim().toUpperCase()
              : "";

          if (currentMRD === mrdNo.toUpperCase()) {
            // tempPatientMaster structure: MRD, Name, Age, Gender, Phone, Address, AdditionalInfo, Type, Status, Empty, RegisteredOn
            // Column 2 is Age (not DOB), so we can't calculate exact age
            return {
              MRDNo:
                row[0] !== undefined && row[0] !== null
                  ? row[0].toString()
                  : "",
              Name:
                row.length > 1 && row[1] !== undefined && row[1] !== null
                  ? row[1].toString()
                  : "",
              DOB: "", // tempPatientMaster doesn't have DOB
              Age:
                row.length > 2 && row[2] !== undefined && row[2] !== null
                  ? row[2].toString()
                  : "", // Age is stored directly
              Gender:
                row.length > 3 && row[3] !== undefined && row[3] !== null
                  ? row[3].toString()
                  : "",
              Phone:
                row.length > 4 && row[4] !== undefined && row[4] !== null
                  ? row[4].toString()
                  : "",
              Address:
                row.length > 5 && row[5] !== undefined && row[5] !== null
                  ? row[5].toString()
                  : "",
              HomeNo: "", // tempPatientMaster doesn't have this
              WorkNo: "", // tempPatientMaster doesn't have this
              RegisteredOn:
                row.length > 10 && row[10] !== undefined && row[10] !== null
                  ? row[10].toString()
                  : "", // Column K
              Type:
                row.length > 7 && row[7] !== undefined && row[7] !== null
                  ? row[7].toString()
                  : "", // Column H
              AdditionalInfo:
                row.length > 6 && row[6] !== undefined && row[6] !== null
                  ? row[6].toString()
                  : "", // Column G
              Status:
                row.length > 8 && row[8] !== undefined && row[8] !== null
                  ? row[8].toString()
                  : "", // Column I
            };
          }
        }
      } catch (e) {}
      return null;
    }

    // First check tempPatientMaster, then patientMaster
    var patient = null;
    try {
      patient = searchInTempPatientMaster(tempPatientMasterSheet);
    } catch (e) {}

    if (!patient) {
      try {
        patient = searchInPatientMaster(patientMasterSheet);
      } catch (e) {}
    }

    if (patient) {
      // Log VIEW_PATIENT audit event ONLY for Level 3+ users (Manager and General User)
      if (sessionToken) {
        try {
          const session = getUserSession(sessionToken);
          if (session && session.role) {
            const userLevel = getUserAccessLevel(session.role);
            if (userLevel >= 3) {
              // Level 3 (Manager) and Level 4 (General User)
              logAuditEvent(sessionToken, "VIEW_PATIENT", "PATIENT", mrdNo, {
                sheetName: patient.MRDNo.startsWith("SPD")
                  ? "patientMaster"
                  : "tempPatientMaster",
              });
            }
          }
        } catch (auditError) {
          // Don't fail patient lookup if audit logging fails
          Logger.log(
            "Audit logging failed for patient view: " + auditError.toString(),
          );
        }
      }

      return { success: true, patient: patient };
    }

    return { success: false, message: "MRD No not found." };
  } catch (error) {
    return {
      success: false,
      message: "Error retrieving patient details: " + error.toString(),
    };
  }
}

// Search patients by phone number (searches columns E, G, H - Phone, HomeNo, WorkNo)
function getPatientsByPhone(phoneNumber) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var patientMasterSheet = ss.getSheetByName("patientMaster");
    var tempPatientMasterSheet = ss.getSheetByName("tempPatientMaster");

    if (!patientMasterSheet && !tempPatientMasterSheet) {
      return { success: false, message: "Patient sheets not found." };
    }

    phoneNumber = phoneNumber.trim();
    if (!phoneNumber) {
      return { success: false, message: "Phone number is required." };
    }

    // Normalize phone number (remove spaces, dashes, etc. for comparison)
    var normalizedSearch = phoneNumber.replace(/[\s\-\(\)]/g, "");

    // Helper function to calculate exact age difference
    function calculateExactAge(dob) {
      var today = new Date();
      var birthDate = new Date(dob);
      var diffInMs = today.getTime() - birthDate.getTime();
      var diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));

      if (diffInDays < 30) {
        return diffInDays + " days";
      } else if (diffInDays < 365) {
        var months = Math.floor(diffInDays / 30);
        return months + " months";
      } else {
        var years = Math.floor(diffInDays / 365);
        return years + " years";
      }
    }

    // Helper function to normalize phone for comparison
    function normalizePhone(phone) {
      if (!phone) return "";
      return phone.toString().replace(/[\s\-\(\)]/g, "");
    }

    // Function to search in patientMaster sheet
    function searchInPatientMasterByPhone(sheet) {
      if (!sheet) return [];
      var patients = [];
      try {
        var data = sheet.getDataRange().getValues();
        if (data.length < 2) return [];

        for (var i = 1; i < data.length; i++) {
          var row = data[i];
          if (!row || row.length === 0) continue;

          // Check columns E (index 4 - Phone), G (index 6 - HomeNo), H (index 7 - WorkNo)
          var phone = normalizePhone(row.length > 4 ? row[4] : "");
          var homeNo = normalizePhone(row.length > 6 ? row[6] : "");
          var workNo = normalizePhone(row.length > 7 ? row[7] : "");

          // Check if any phone matches
          if (
            phone === normalizedSearch ||
            homeNo === normalizedSearch ||
            workNo === normalizedSearch
          ) {
            // Handle DOB - column 2
            var dob = null;
            var exactAge = "";
            var dobFormatted = "";
            try {
              if (row.length > 2 && row[2]) {
                dob = new Date(row[2]);
                if (!isNaN(dob.getTime())) {
                  exactAge = calculateExactAge(dob);
                  try {
                    var timeZone = Session.getScriptTimeZone();
                    dobFormatted = Utilities.formatDate(
                      dob,
                      timeZone,
                      "yyyy-MM-dd",
                    );
                  } catch (tzError) {
                    var year = dob.getFullYear();
                    var month = String(dob.getMonth() + 1).padStart(2, "0");
                    var day = String(dob.getDate()).padStart(2, "0");
                    dobFormatted = year + "-" + month + "-" + day;
                  }
                }
              }
            } catch (e) {}

            patients.push({
              MRDNo:
                row[0] !== undefined && row[0] !== null
                  ? row[0].toString()
                  : "",
              Name:
                row.length > 1 && row[1] !== undefined && row[1] !== null
                  ? row[1].toString()
                  : "",
              DOB: dobFormatted,
              Age: exactAge,
              Gender:
                row.length > 3 && row[3] !== undefined && row[3] !== null
                  ? row[3].toString()
                  : "",
              Phone:
                row.length > 4 && row[4] !== undefined && row[4] !== null
                  ? row[4].toString()
                  : "",
              Address:
                row.length > 5 && row[5] !== undefined && row[5] !== null
                  ? row[5].toString()
                  : "",
              HomeNo:
                row.length > 6 && row[6] !== undefined && row[6] !== null
                  ? row[6].toString()
                  : "",
              WorkNo:
                row.length > 7 && row[7] !== undefined && row[7] !== null
                  ? row[7].toString()
                  : "",
              RegisteredOn:
                row.length > 8 && row[8] !== undefined && row[8] !== null
                  ? row[8].toString()
                  : "",
              Type:
                row.length > 9 && row[9] !== undefined && row[9] !== null
                  ? row[9].toString()
                  : "",
              AdditionalInfo:
                row.length > 10 && row[10] !== undefined && row[10] !== null
                  ? row[10].toString()
                  : "",
              Status:
                row.length > 11 && row[11] !== undefined && row[11] !== null
                  ? row[11].toString()
                  : "",
            });
          }
        }
      } catch (e) {}
      return patients;
    }

    // Function to search in tempPatientMaster sheet
    function searchInTempPatientMasterByPhone(sheet) {
      if (!sheet) return [];
      var patients = [];
      try {
        var data = sheet.getDataRange().getValues();
        if (data.length < 2) return [];

        for (var i = 1; i < data.length; i++) {
          var row = data[i];
          if (!row || row.length === 0) continue;

          // tempPatientMaster: Phone is column E (index 4)
          // Note: tempPatientMaster may not have HomeNo/WorkNo columns
          var phone = normalizePhone(row.length > 4 ? row[4] : "");

          if (phone === normalizedSearch) {
            patients.push({
              MRDNo:
                row[0] !== undefined && row[0] !== null
                  ? row[0].toString()
                  : "",
              Name:
                row.length > 1 && row[1] !== undefined && row[1] !== null
                  ? row[1].toString()
                  : "",
              DOB: "",
              Age:
                row.length > 2 && row[2] !== undefined && row[2] !== null
                  ? row[2].toString()
                  : "",
              Gender:
                row.length > 3 && row[3] !== undefined && row[3] !== null
                  ? row[3].toString()
                  : "",
              Phone:
                row.length > 4 && row[4] !== undefined && row[4] !== null
                  ? row[4].toString()
                  : "",
              Address:
                row.length > 5 && row[5] !== undefined && row[5] !== null
                  ? row[5].toString()
                  : "",
              HomeNo: "",
              WorkNo: "",
              RegisteredOn:
                row.length > 10 && row[10] !== undefined && row[10] !== null
                  ? row[10].toString()
                  : "",
              Type:
                row.length > 7 && row[7] !== undefined && row[7] !== null
                  ? row[7].toString()
                  : "",
              AdditionalInfo:
                row.length > 6 && row[6] !== undefined && row[6] !== null
                  ? row[6].toString()
                  : "",
              Status:
                row.length > 8 && row[8] !== undefined && row[8] !== null
                  ? row[8].toString()
                  : "",
            });
          }
        }
      } catch (e) {}
      return patients;
    }

    // Search both sheets
    var allPatients = [];
    try {
      var tempPatients = searchInTempPatientMasterByPhone(
        tempPatientMasterSheet,
      );
      allPatients = allPatients.concat(tempPatients);
    } catch (e) {}

    try {
      var masterPatients = searchInPatientMasterByPhone(patientMasterSheet);
      allPatients = allPatients.concat(masterPatients);
    } catch (e) {}

    // Remove duplicates based on MRDNo
    var uniquePatients = [];
    var seenMRDs = {};
    for (var i = 0; i < allPatients.length; i++) {
      var mrd = allPatients[i].MRDNo;
      if (!seenMRDs[mrd]) {
        seenMRDs[mrd] = true;
        uniquePatients.push(allPatients[i]);
      }
    }

    if (uniquePatients.length > 0) {
      return { success: true, patients: uniquePatients };
    }

    return {
      success: false,
      message: "No patients found with this phone number.",
    };
  } catch (error) {
    return {
      success: false,
      message: "Error retrieving patient details: " + error.toString(),
    };
  }
}

// Get existing appointments by MRD Number
function getExistingAppointmentsByMRD(mrdNo) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var appointmentSheet = ss.getSheetByName("appointment");

    if (!appointmentSheet) {
      return { success: false, message: "Appointment sheet not found." };
    }

    // Normalize the MRD number (same logic as getPatientDetailsByMRD)
    mrdNo = mrdNo.trim();

    if (/^\d+$/.test(mrdNo)) {
      mrdNo = "SPD" + mrdNo;
    } else if (/^SPD$/i.test(mrdNo)) {
      mrdNo = "SPD0";
    } else if (/^SPD/i.test(mrdNo)) {
      var numPart = mrdNo.replace(/^SPD/i, "");
      if (/^\d+$/.test(numPart)) {
        mrdNo = "SPD" + numPart;
      }
    }

    var data = appointmentSheet.getDataRange().getValues();
    var headers = data[0];
    var existingAppointments = [];

    // Find MRD column index
    var mrdIndex = -1;
    for (var i = 0; i < headers.length; i++) {
      if (headers[i] && typeof headers[i] === "string") {
        var headerLower = headers[i].toLowerCase().replace(/\s+/g, "");
        if (headerLower === "mrdno" || headerLower === "mrd") {
          mrdIndex = i;
          break;
        }
      }
    }

    if (mrdIndex === -1) {
      return {
        success: false,
        message: "MRD No column not found in appointment sheet.",
      };
    }

    // Search for appointments with matching MRD
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var rowMrd = row[mrdIndex] ? row[mrdIndex].toString().trim() : "";

      if (rowMrd === mrdNo) {
        var appointment = {};
        for (var j = 0; j < headers.length; j++) {
          appointment[headers[j]] = row[j] ? row[j].toString() : "";
        }
        existingAppointments.push(appointment);
      }
    }

    return {
      success: true,
      appointments: existingAppointments,
      count: existingAppointments.length,
    };
  } catch (error) {
    return {
      success: false,
      message: "Error retrieving existing appointments: " + error.toString(),
    };
  }
}

//Book appointment, Appointment Type
function getAppointmentTypes() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("generalSettings");
    if (!sheet) {
      return { success: false, message: "generalSettings sheet not found." };
    }

    // Get the appointment types from cell D2
    var cellValue = sheet.getRange("D2").getValue();
    if (!cellValue) {
      return {
        success: false,
        message: "No appointment types found in cell D2.",
      };
    }

    // Split the cell's value by comma, trim each type, and filter out any empty strings
    var appointmentTypes = cellValue
      .split(",")
      .map(function (item) {
        return item.trim();
      })
      .filter(function (item) {
        return item !== "";
      });

    return { success: true, appointmentTypes: appointmentTypes };
  } catch (error) {
    return { success: false, message: error.toString() };
  }
}

/**
 * Submit a new appointment.
 * appointmentData is an object containing:
 *   - patientType: "existingPatient" or "newPatient"
 *   - patientData: Object with patient details (MRDNo, Name, Age, Gender, Phone, Address, PatientType)
 *   - appointmentType, doctor, appointmentDate, timeSlot, planOfAction, remarks
 *   - sessionToken (for retrieving BookedBy)
 */
function submitAppointment(appointmentData) {
  try {
    // Validate session and check Level 4 constraints
    var session = getUserSession(appointmentData.sessionToken);
    if (!session) {
      return {
        success: false,
        message: "Session expired or invalid. Please login again.",
      };
    }
    var userLevel = getUserAccessLevel(session.role);
    if (userLevel === 4 && appointmentData.patientType === "newPatient") {
      return {
        success: false,
        message: "Level 4 login access is not permitted to book New Patients. Only Existing Patients can be booked.",
      };
    }

    // Validate appointment data format
    var validation = validateAppointmentData(appointmentData);
    if (!validation.valid) {
      return {
        success: false,
        message: "Validation failed: " + validation.errors.join(", "),
      };
    }

    // Normalize date and time values
    try {
      appointmentData.appointmentDate = normalizeAppointmentDate(
        appointmentData.appointmentDate,
      );

      // Only normalize time slot if not a waiting list appointment
      if (
        appointmentData.appointmentType !== "WAITING LIST" &&
        appointmentData.timeSlot
      ) {
        appointmentData.timeSlot = normalizeTimeSlot(appointmentData.timeSlot);
      }
    } catch (normalizationError) {
      return {
        success: false,
        message: "Failed to normalize date/time: " + normalizationError.message,
      };
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var appointmentSheet = ss.getSheetByName("appointment");
    if (!appointmentSheet) {
      throw new Error("Appointment sheet not found.");
    }

    // Check and ensure the header for column Z is "Fixed Slot"
    var headers = appointmentSheet
      .getRange(1, 1, 1, appointmentSheet.getLastColumn())
      .getValues()[0];

    // Check if we need to add the Fixed Slot header
    var fixedSlotColIndex = headers.indexOf("Fixed Slot");
    if (fixedSlotColIndex === -1) {
      // If Fixed Slot column doesn't exist, add it to column Z (26)
      fixedSlotColIndex = 25; // 0-based index for column Z
      if (appointmentSheet.getLastColumn() < 26) {
        // If sheet doesn't have 26 columns yet, add columns up to Z
        appointmentSheet.insertColumnsAfter(
          appointmentSheet.getLastColumn(),
          26 - appointmentSheet.getLastColumn(),
        );
      }
      appointmentSheet.getRange(1, 26).setValue("Fixed Slot");
      headers[25] = "Fixed Slot";
    }

    // Check if we need to add the Urgency Level header in column AB (28)
    var urgencyLevelColIndex = headers.indexOf("Urgency Level");
    if (urgencyLevelColIndex === -1) {
      // If Urgency Level column doesn't exist, add it to column AB (28)
      urgencyLevelColIndex = 27; // 0-based index for column AB
      if (appointmentSheet.getLastColumn() < 28) {
        // If sheet doesn't have 28 columns yet, add columns up to AB
        appointmentSheet.insertColumnsAfter(
          appointmentSheet.getLastColumn(),
          28 - appointmentSheet.getLastColumn(),
        );
      }
      appointmentSheet.getRange(1, 28).setValue("Urgency Level");
      headers[27] = "Urgency Level";
    }

    // Check if we need to add the Family Identifier header in column AC (29)
    var familyIdentifierColIndex = headers.indexOf("Family Identifier");
    if (familyIdentifierColIndex === -1) {
      // If Family Identifier column doesn't exist, add it to column AC (29)
      familyIdentifierColIndex = 28; // 0-based index for column AC
      if (appointmentSheet.getLastColumn() < 29) {
        // If sheet doesn't have 29 columns yet, add columns up to AC
        appointmentSheet.insertColumnsAfter(
          appointmentSheet.getLastColumn(),
          29 - appointmentSheet.getLastColumn(),
        );
      }
      appointmentSheet.getRange(1, 29).setValue("Family Identifier");
      headers[28] = "Family Identifier";
    }

    // Check if we need to add the Consult Start header in column AD (30)
    var consultStartColIndex = headers.indexOf("Consult Start");
    if (consultStartColIndex === -1) {
      // If Consult Start column doesn't exist, add it to column AD (30)
      consultStartColIndex = 29; // 0-based index for column AD
      if (appointmentSheet.getLastColumn() < 30) {
        // If sheet doesn't have 30 columns yet, add columns up to AD
        appointmentSheet.insertColumnsAfter(
          appointmentSheet.getLastColumn(),
          30 - appointmentSheet.getLastColumn(),
        );
      }
      appointmentSheet.getRange(1, 30).setValue("Consult Start");
      headers[29] = "Consult Start";
    }

    // Check if we need to add the SlotStatus header in column AG (33)
    var slotStatusColIndex = headers.indexOf("SlotStatus");
    if (slotStatusColIndex === -1) {
      slotStatusColIndex = 32; // 0-based index for column AG
      if (appointmentSheet.getLastColumn() < 33) {
        appointmentSheet.insertColumnsAfter(
          appointmentSheet.getLastColumn(),
          33 - appointmentSheet.getLastColumn(),
        );
      }
      appointmentSheet.getRange(1, 33).setValue("SlotStatus");
      headers[32] = "SlotStatus";
    }

    // Generate timestamp-based appointment ID
    var now = new Date();
    var appointmentID = Utilities.formatDate(
      now,
      Session.getScriptTimeZone(),
      "yyyyMMdd_HHmmss",
    );

    // For existing patients, fetch details from patientMaster
    if (appointmentData.patientType === "existingPatient") {
      var patientDetails = getPatientDetailsByMRD(
        appointmentData.patientData.MRDNo,
      );
      if (!patientDetails.success) {
        throw new Error(
          "Failed to fetch existing patient details: " + patientDetails.message,
        );
      }
      // Use the fetched patient details
      appointmentData.patientData = patientDetails.patient;
    }

    // For new patients, generate MRD number and add to tempPatientMaster
    else if (appointmentData.patientType === "newPatient") {
      var newMRD = generateNewMRD();
      appointmentData.patientData.MRDNo = newMRD;

      // Add new patient to tempPatientMaster sheet
      var tempPatientMasterSheet = ss.getSheetByName("tempPatientMaster");
      if (!tempPatientMasterSheet) {
        throw new Error("tempPatientMaster sheet not found.");
      }
      var newPatientRow = [
        newMRD, // MRD No (Column A)
        appointmentData.patientData.Name, // Name (Column B)
        appointmentData.patientData.Age, // Age (Column C) - Direct input from form
        appointmentData.patientData.Gender, // Gender (Column D)
        appointmentData.patientData.Phone, // Phone (Column E)
        appointmentData.patientData.Address, // Address (Column F)
        appointmentData.patientData.AdditionalInfo || "", // Additional Info (Column G)
        appointmentData.patientData.Type, // Type (Column H)
        "Active", // Status (Column I)
        "", // Empty Column (Column J)
        now, // RegisteredOn (Column K)
        appointmentData.fixedSlot ? "Yes" : "", // Fixed Slot (Column Z)
      ];

      tempPatientMasterSheet.appendRow(newPatientRow);
    }

    // Prepare appointment record
    var bookedBy = getSessionUsername(appointmentData.sessionToken);
    var bookingDate = Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone(),
      "yyyy-MM-dd",
    );

    // Get slot status for the appointment date
    var slotStatus = "";
    try {
      var slotStatusData = getSlotStatusForDate(
        appointmentData.appointmentDate,
      );
      slotStatus = JSON.stringify(slotStatusData);
    } catch (e) {
      slotStatus = "";
    }

    // Create an array with 33 elements (A through AG)
    var newRow = new Array(33).fill("");

    // Get patient type from the appointmentData
    var patientType = "";
    if (appointmentData.patientType === "existingPatient") {
      patientType = appointmentData.patientData.Type || "";
    } else {
      patientType = appointmentData.patientData.Type || "";
    }

    // Fill in the appointment data at the correct indices
    newRow[0] = appointmentID; // Appointment ID (Column A)
    newRow[1] = appointmentData.appointmentDate; // Appointment Date (Column B)
    newRow[2] = appointmentData.timeSlot; // Time Slot (Column C)
    newRow[3] = appointmentData.patientData.MRDNo; // MRD No (Column D)
    newRow[4] = appointmentData.patientData.Name; // Name (Column E)
    newRow[5] = appointmentData.patientData.Age; // Age (Column F)
    newRow[6] = appointmentData.patientData.Gender; // Gender (Column G)
    newRow[7] = appointmentData.patientData.Phone; // Phone (Column H)
    newRow[8] = appointmentData.appointmentType; // Appointment Type (Column I)
    newRow[9] = appointmentData.doctor; // Doctor (Column J)
    newRow[10] = appointmentData.planOfAction; // Plan of Action (Column K)
    newRow[11] = ""; // Remarks (Column L) - Will be populated from history
    newRow[12] = bookedBy; // Booked By (Column M)
    newRow[13] = bookingDate; // Booking Date (Column N)
    newRow[14] = ""; // FourDayConfirmDate (Column O)
    newRow[15] = ""; // FourDayConfirmBy (Column P)
    newRow[16] = ""; // OneDayConfirmDate (Column Q)
    newRow[17] = ""; // OneDayConfirmBy (Column R)
    newRow[18] = ""; // RescheduledDate (Column S)
    newRow[19] = ""; // RescheduledBy (Column T)
    newRow[25] = appointmentData.fixedSlot || ""; // Fixed Slot (Column Z)
    newRow[26] = patientType; // Patient Type (Column AA)
    newRow[27] = appointmentData.urgencyLevel || ""; // Urgency Level (Column AB)
    newRow[28] = appointmentData.familyIdentifier || ""; // Family Identifier (Column AC)
    newRow[29] = appointmentData.consultStart || ""; // Consult Start (Column AD)
    newRow[32] = slotStatus; // SlotStatus (Column AG)

    appointmentSheet.appendRow(newRow);

    // Add initial remark to history if provided
    if (appointmentData.remarks && appointmentData.remarks.trim() !== "") {
      addRemarkToHistory(
        appointmentID,
        appointmentData.remarks.trim(),
        appointmentData.sessionToken,
      );
    }

    // Auto-calculate Consult Start when applicable (skip waiting list or missing time slot)
    var shouldCalculateConsultStart =
      appointmentData.timeSlot &&
      appointmentData.timeSlot !== "" &&
      (!appointmentData.appointmentType ||
        appointmentData.appointmentType.toString().toUpperCase() !==
          "WAITING LIST");
    if (shouldCalculateConsultStart) {
      try {
        var consultStartResult = calculateConsultStartForAppointments();
        if (!consultStartResult || !consultStartResult.success) {
        }
      } catch (consultError) {}
    }

    // ✅ ETERNAL TRACKING: Log journey entry for creation
    logAppointmentJourney(
      appointmentID,
      "created",
      null,
      "appointment",
      bookedBy,
      {
        toDate: appointmentData.appointmentDate,
        toTime: appointmentData.timeSlot,
        description:
          "Appointment created for " + appointmentData.patientData.Name,
      },
    );

    // Update planningA sheet to mark slot as booked
    try {
      updatePlanningASheet();
    } catch (planningError) {}

    // Update planningB stats after booking
    try {
      updatePlanningBStats(appointmentData.appointmentDate);
    } catch (planningBError) {}

    // Log audit event for appointment booking
    try {
      logAuditEvent(
        appointmentData.sessionToken,
        "BOOK_APPOINTMENT",
        "APPOINTMENT",
        appointmentID,
        {
          date: appointmentData.appointmentDate,
          time: appointmentData.timeSlot || "WAITING LIST",
          mrd: appointmentData.patientData.MRDNo,
          patientName: appointmentData.patientData.Name,
          doctor: appointmentData.doctor,
          appointmentType: appointmentData.appointmentType,
          sheetName: "appointment",
        },
      );
    } catch (auditError) {
      // Don't fail appointment creation if audit logging fails
      Logger.log(
        "Audit logging failed for appointment booking: " +
          auditError.toString(),
      );
    }

    return {
      success: true,
      // Returned so the payment module can attach a payment request to this
      // appointment (PaymentApi.gs). Existing callers read only success/message.
      appointmentId: appointmentID,
      mrdNo: appointmentData.patientData.MRDNo,
      message:
        "Appointment submitted successfully." +
        (appointmentData.patientType === "newPatient"
          ? " New MRD Number: " + appointmentData.patientData.MRDNo
          : ""),
    };
  } catch (e) {
    return {
      success: false,
      message: "Error submitting appointment: " + e.toString(),
    };
  }
}

/**
 * Creates an appointment from a followup appointment
 * @param {Object} appointmentData - Appointment data including followup info
 * @param {string} appointmentData.aFollowID - Followup ID
 * @param {string} appointmentData.appointmentDate - Appointment date
 * @param {string} appointmentData.timeSlot - Time slot
 * @param {string} appointmentData.doctor - Doctor name
 * @param {string} appointmentData.appointmentType - Appointment type
 * @param {string} appointmentData.planOfAction - Plan of action
 * @param {string} appointmentData.additionalComments - Additional comments to add to remarks
 * @param {string} sessionToken - Session token
 * @return {Object} Success/failure response
 */
function createAppointmentFromFollowup(appointmentData, sessionToken) {
  try {
    // Validate appointment data format
    var validation = validateAppointmentData(appointmentData);
    if (!validation.valid) {
      return {
        success: false,
        message: "Validation failed: " + validation.errors.join(", "),
      };
    }

    // Normalize date and time values
    try {
      appointmentData.appointmentDate = normalizeAppointmentDate(
        appointmentData.appointmentDate,
      );
      if (
        appointmentData.timeSlot &&
        appointmentData.appointmentType !== "WAITING LIST"
      ) {
        appointmentData.timeSlot = normalizeTimeSlot(appointmentData.timeSlot);
      }
    } catch (normalizationError) {
      return {
        success: false,
        message: "Data normalization failed: " + normalizationError.message,
      };
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var appointmentSheet = ss.getSheetByName("appointment");
    var followupSheet = ss.getSheetByName("followup");

    if (!appointmentSheet) {
      throw new Error("Appointment sheet not found.");
    }

    if (!followupSheet) {
      throw new Error("Followup sheet not found.");
    }

    // Get followup data
    const followupData = followupSheet.getDataRange().getValues();
    const followupHeaders = followupData[0];
    const aFollowIDCol = followupHeaders.indexOf("aFollowID");
    const mrdCol = followupHeaders.indexOf("MRDNo");
    const nameCol = followupHeaders.indexOf("PatientName");
    const ageCol = followupHeaders.indexOf("Age");
    const genderCol = followupHeaders.indexOf("Gender");
    const phoneCol = followupHeaders.indexOf("Phone");
    const commentsCol = followupHeaders.indexOf("comments");

    if (aFollowIDCol === -1) {
      throw new Error("aFollowID column not found in followup sheet");
    }

    // Find the followup record
    let followupRow = null;
    for (let i = 1; i < followupData.length; i++) {
      if (
        followupData[i][aFollowIDCol] &&
        followupData[i][aFollowIDCol].toString() === appointmentData.aFollowID
      ) {
        followupRow = followupData[i];
        break;
      }
    }

    if (!followupRow) {
      throw new Error(
        "Followup record not found for aFollowID: " + appointmentData.aFollowID,
      );
    }

    // Get patient data from followup
    const patientData = {
      MRDNo: followupRow[mrdCol] || "",
      Name: followupRow[nameCol] || "",
      Age: followupRow[ageCol] || "",
      Gender: followupRow[genderCol] || "",
      Phone: followupRow[phoneCol] || "",
      Address: "", // Not in followup sheet
      Type: "", // Not in followup sheet
    };

    // Get comments from followup (column G)
    const followupComments = followupRow[commentsCol] || "";

    // Combine followup comments with additional comments
    let remarks = "";
    if (followupComments && followupComments.toString().trim() !== "") {
      remarks = followupComments.toString().trim();
    }
    if (
      appointmentData.additionalComments &&
      appointmentData.additionalComments.toString().trim() !== ""
    ) {
      if (remarks) {
        remarks += " | " + appointmentData.additionalComments.toString().trim();
      } else {
        remarks = appointmentData.additionalComments.toString().trim();
      }
    }

    // Check and ensure headers exist
    var headers = appointmentSheet
      .getRange(1, 1, 1, appointmentSheet.getLastColumn())
      .getValues()[0];

    // Check for required columns and add if missing
    var fixedSlotColIndex = headers.indexOf("Fixed Slot");
    if (fixedSlotColIndex === -1) {
      fixedSlotColIndex = 25;
      if (appointmentSheet.getLastColumn() < 26) {
        appointmentSheet.insertColumnsAfter(
          appointmentSheet.getLastColumn(),
          26 - appointmentSheet.getLastColumn(),
        );
      }
      appointmentSheet.getRange(1, 26).setValue("Fixed Slot");
      headers[25] = "Fixed Slot";
    }

    var urgencyLevelColIndex = headers.indexOf("Urgency Level");
    if (urgencyLevelColIndex === -1) {
      urgencyLevelColIndex = 27;
      if (appointmentSheet.getLastColumn() < 28) {
        appointmentSheet.insertColumnsAfter(
          appointmentSheet.getLastColumn(),
          28 - appointmentSheet.getLastColumn(),
        );
      }
      appointmentSheet.getRange(1, 28).setValue("Urgency Level");
      headers[27] = "Urgency Level";
    }

    var familyIdentifierColIndex = headers.indexOf("Family Identifier");
    if (familyIdentifierColIndex === -1) {
      familyIdentifierColIndex = 28;
      if (appointmentSheet.getLastColumn() < 29) {
        appointmentSheet.insertColumnsAfter(
          appointmentSheet.getLastColumn(),
          29 - appointmentSheet.getLastColumn(),
        );
      }
      appointmentSheet.getRange(1, 29).setValue("Family Identifier");
      headers[28] = "Family Identifier";
    }

    var consultStartColIndex = headers.indexOf("Consult Start");
    if (consultStartColIndex === -1) {
      consultStartColIndex = 29;
      if (appointmentSheet.getLastColumn() < 30) {
        appointmentSheet.insertColumnsAfter(
          appointmentSheet.getLastColumn(),
          30 - appointmentSheet.getLastColumn(),
        );
      }
      appointmentSheet.getRange(1, 30).setValue("Consult Start");
      headers[29] = "Consult Start";
    }

    // Check for aFollowID column (to track booking source)
    var aFollowIDColIndex = headers.indexOf("aFollowID");
    if (aFollowIDColIndex === -1) {
      // Add aFollowID column after Consult Start (column AE, index 30)
      aFollowIDColIndex = 30;
      if (appointmentSheet.getLastColumn() < 31) {
        appointmentSheet.insertColumnsAfter(
          appointmentSheet.getLastColumn(),
          31 - appointmentSheet.getLastColumn(),
        );
      }
      appointmentSheet.getRange(1, 31).setValue("aFollowID");
      headers[30] = "aFollowID";
    }

    // Check if we need to add the SlotStatus header in column AG (33)
    var slotStatusColIndex = headers.indexOf("SlotStatus");
    if (slotStatusColIndex === -1) {
      slotStatusColIndex = 32; // 0-based index for column AG
      if (appointmentSheet.getLastColumn() < 33) {
        appointmentSheet.insertColumnsAfter(
          appointmentSheet.getLastColumn(),
          33 - appointmentSheet.getLastColumn(),
        );
      }
      appointmentSheet.getRange(1, 33).setValue("SlotStatus");
      headers[32] = "SlotStatus";
    }

    // Generate timestamp-based appointment ID
    var now = new Date();
    var appointmentID = Utilities.formatDate(
      now,
      Session.getScriptTimeZone(),
      "yyyyMMdd_HHmmss",
    );

    // Prepare appointment record
    var bookedBy = getSessionUsername(sessionToken);
    var bookingDate = Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone(),
      "yyyy-MM-dd",
    );

    // Get slot status for the appointment date
    var slotStatus = "";
    try {
      var slotStatusData = getSlotStatusForDate(
        appointmentData.appointmentDate,
      );
      slotStatus = JSON.stringify(slotStatusData);
    } catch (e) {
      slotStatus = "";
    }

    // Create an array with enough elements
    var newRow = new Array(Math.max(33, appointmentSheet.getLastColumn())).fill(
      "",
    );

    // Fill in the appointment data
    newRow[0] = appointmentID; // Appointment ID (Column A)
    newRow[1] = appointmentData.appointmentDate; // Appointment Date (Column B)
    newRow[2] = appointmentData.timeSlot; // Time Slot (Column C)
    newRow[3] = patientData.MRDNo; // MRD No (Column D)
    newRow[4] = patientData.Name; // Name (Column E)
    newRow[5] = patientData.Age; // Age (Column F)
    newRow[6] = patientData.Gender; // Gender (Column G)
    newRow[7] = patientData.Phone; // Phone (Column H)
    newRow[8] = appointmentData.appointmentType; // Appointment Type (Column I)
    newRow[9] = appointmentData.doctor; // Doctor (Column J)
    newRow[10] = appointmentData.planOfAction; // Plan of Action (Column K)
    newRow[11] = remarks; // Remarks (Column L) - Combined comments
    newRow[12] = bookedBy; // Booked By (Column M)
    newRow[13] = bookingDate; // Booking Date (Column N)
    newRow[30] = appointmentData.aFollowID; // aFollowID (Column AE) - Track booking source
    newRow[32] = slotStatus; // SlotStatus (Column AG)

    appointmentSheet.appendRow(newRow);

    // Add initial remark to history if remarks provided
    if (remarks && remarks.trim() !== "") {
      addRemarkToHistory(appointmentID, remarks.trim(), sessionToken);
    }

    // Auto-calculate Consult Start
    if (
      appointmentData.timeSlot &&
      appointmentData.timeSlot !== "" &&
      (!appointmentData.appointmentType ||
        appointmentData.appointmentType.toString().toUpperCase() !==
          "WAITING LIST")
    ) {
      try {
        var consultStartResult = calculateConsultStartForAppointments();
        if (!consultStartResult || !consultStartResult.success) {
        }
      } catch (consultError) {}
    }

    // Log journey entry for creation
    logAppointmentJourney(
      appointmentID,
      "created",
      null,
      "appointment",
      bookedBy,
      {
        toDate: appointmentData.appointmentDate,
        toTime: appointmentData.timeSlot,
        description:
          "Appointment created from followup " + appointmentData.aFollowID,
      },
    );

    // Update planningA sheet to mark slot as booked
    try {
      updatePlanningASheet();
    } catch (planningError) {}

    // Update planningB stats after booking
    try {
      updatePlanningBStats(appointmentData.appointmentDate);
    } catch (planningBError) {}

    // Log audit event for appointment booking from followup
    try {
      logAuditEvent(
        sessionToken,
        "BOOK_APPOINTMENT_FROM_FOLLOWUP",
        "APPOINTMENT",
        appointmentID,
        {
          date: appointmentData.appointmentDate,
          time: appointmentData.timeSlot || "WAITING LIST",
          mrd: patientData.MRDNo,
          patientName: patientData.Name,
          doctor: appointmentData.doctor,
          appointmentType: appointmentData.appointmentType,
          aFollowID: appointmentData.aFollowID,
          sheetName: "appointment",
        },
      );
    } catch (auditError) {
      // Don't fail appointment creation if audit logging fails
      Logger.log(
        "Audit logging failed for followup appointment booking: " +
          auditError.toString(),
      );
    }

    return {
      success: true,
      message: "Appointment created successfully",
      appointmentID: appointmentID,
    };
  } catch (error) {
    return {
      success: false,
      message: "Error creating appointment: " + error.toString(),
    };
  }
}

/**
 * Initializes or ensures the planningA sheet exists with proper structure
 * Column A: Dates (90 days from current date)
 * Columns B onwards: Time slots (e.g., "09:00", "09:30", "10:00", etc.)
 * Empty cells indicate available slots
 */
function initializePlanningASheet() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let planningSheet = ss.getSheetByName("planningA");

    if (!planningSheet) {
      planningSheet = ss.insertSheet("planningA");

      // Generate time slots (every 10 minutes from 09:00 to 18:00)
      const timeSlots = [];
      for (let hour = 9; hour < 18; hour++) {
        for (let minute = 0; minute < 60; minute += 10) {
          const timeStr =
            (hour < 10 ? "0" : "") +
            hour +
            ":" +
            (minute < 10 ? "0" : "") +
            minute;
          timeSlots.push(timeStr);
        }
      }

      // Set up headers: Date in A1, then time slots in B1, C1, etc.
      const headers = ["Date", ...timeSlots];
      planningSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      planningSheet.setFrozenRows(1);
      planningSheet.setFrozenColumns(1);
    } else {
      // Ensure headers exist even if sheet already exists
      const existingHeaders = planningSheet.getRange(1, 1, 1, 1).getValue();
      if (!existingHeaders || existingHeaders !== "Date") {
        // Generate time slots (every 10 minutes from 09:00 to 18:00)
        const timeSlots = [];
        for (let hour = 9; hour < 18; hour++) {
          for (let minute = 0; minute < 60; minute += 10) {
            const timeStr =
              (hour < 10 ? "0" : "") +
              hour +
              ":" +
              (minute < 10 ? "0" : "") +
              minute;
            timeSlots.push(timeStr);
          }
        }

        const headers = ["Date", ...timeSlots];
        planningSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
        planningSheet.setFrozenRows(1);
        planningSheet.setFrozenColumns(1);
      }
    }

    return planningSheet;
  } catch (e) {
    throw e;
  }
}

/**
 * Updates planningA sheet by checking appointment sheet for filled slots
 * Marks slots as booked by filling them with "BOOKED"
 */
function updatePlanningASheet() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const planningSheet = initializePlanningASheet();
    const appointmentSheet = ss.getSheetByName("appointment");

    if (!appointmentSheet) {
      return;
    }

    // Get appointment data
    const appointmentData = appointmentSheet.getDataRange().getValues();
    const appointmentHeaders = appointmentData[0];
    const dateCol = appointmentHeaders.indexOf("AppointmentDate");
    const timeSlotCol = appointmentHeaders.indexOf("TimeSlot");
    const deletedOnCol = appointmentHeaders.indexOf("Deleted On");
    const archivedOnCol = appointmentHeaders.indexOf("Archived on");

    if (dateCol === -1 || timeSlotCol === -1) {
      return;
    }

    // Get planningA data
    const planningData = planningSheet.getDataRange().getValues();
    const planningHeaders = planningData[0];

    // Create a map of date -> row index in planningA (handle both Date objects and strings)
    const dateToRowMap = {};
    for (let i = 1; i < planningData.length; i++) {
      const dateValue = planningData[i][0];
      let dateStr = "";

      if (dateValue instanceof Date) {
        dateStr = Utilities.formatDate(
          dateValue,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd",
        );
      } else if (dateValue) {
        dateStr = dateValue.toString().trim();
      }

      if (dateStr) {
        dateToRowMap[dateStr] = i + 1; // +1 because sheet rows are 1-indexed
      }
    }

    // Find time slot column indices in planningA - normalize headers like in getAvailableSlotsFromPlanningA
    const timeSlotColMap = {};
    for (let col = 1; col < planningHeaders.length; col++) {
      const headerValue = planningHeaders[col];
      if (!headerValue) continue;

      // Normalize header to HH:MM format (same logic as getAvailableSlotsFromPlanningA)
      let slotLabel = "";
      if (headerValue instanceof Date) {
        // Already in proper Date format, just render as HH:mm
        slotLabel = Utilities.formatDate(
          headerValue,
          Session.getScriptTimeZone(),
          "HH:mm",
        );
      } else {
        const raw = headerValue.toString().trim();
        // Extract time-like pattern (e.g., "09:00" or "9:00")
        const timeMatch = raw.match(/(\d{1,2}):(\d{2})/);
        if (timeMatch) {
          const hour = parseInt(timeMatch[1], 10);
          const minute = parseInt(timeMatch[2], 10);
          const minuteStr = (minute < 10 ? "0" : "") + minute; // Ensure minutes are always 2 digits
          slotLabel = (hour < 10 ? "0" : "") + hour + ":" + minuteStr;
        } else {
          continue; // Skip if not a valid time format
        }
      }

      if (slotLabel) {
        timeSlotColMap[slotLabel] = col + 1; // +1 because sheet columns are 1-indexed
      }
    }

    // Clear all existing "BOOKED" markers first
    if (planningSheet.getLastRow() > 1 && planningSheet.getLastColumn() > 1) {
      const dataRange = planningSheet.getRange(
        2,
        2,
        planningSheet.getLastRow() - 1,
        planningSheet.getLastColumn() - 1,
      );
      const values = dataRange.getValues();
      for (let i = 0; i < values.length; i++) {
        for (let j = 0; j < values[i].length; j++) {
          if (values[i][j] === "BOOKED") {
            planningSheet.getRange(i + 2, j + 2).clearContent();
          }
        }
      }
    }

    // Mark booked slots
    let bookedCount = 0;
    let skippedCount = 0;

    for (let i = 1; i < appointmentData.length; i++) {
      const appointmentDate = appointmentData[i][dateCol];
      const timeSlot = appointmentData[i][timeSlotCol];
      const deletedOn =
        deletedOnCol !== -1 ? appointmentData[i][deletedOnCol] : null;
      const archivedOn =
        archivedOnCol !== -1 ? appointmentData[i][archivedOnCol] : null;

      // Skip deleted or archived appointments
      if (deletedOn && deletedOn.toString().trim() !== "") {
        skippedCount++;
        continue;
      }
      if (archivedOn && archivedOn.toString().trim() !== "") {
        skippedCount++;
        continue;
      }

      if (!appointmentDate || !timeSlot) {
        skippedCount++;
        continue;
      }

      // Format date (handle both Date objects and strings)
      let dateStr = "";
      if (appointmentDate instanceof Date) {
        dateStr = Utilities.formatDate(
          appointmentDate,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd",
        );
      } else {
        dateStr = appointmentDate.toString().trim();
      }

      // Format time slot to HH:MM (normalize like headers)
      let timeSlotStr = timeSlot.toString().trim();
      const timeMatch = timeSlotStr.match(/(\d{1,2}):(\d{2})/);
      if (timeMatch) {
        const hour = parseInt(timeMatch[1], 10);
        const minute = parseInt(timeMatch[2], 10);
        const minuteStr = (minute < 10 ? "0" : "") + minute; // Ensure minutes are always 2 digits
        timeSlotStr = (hour < 10 ? "0" : "") + hour + ":" + minuteStr;
      } else {
        skippedCount++;
        continue;
      }

      // Find row and column in planningA
      const row = dateToRowMap[dateStr];
      const col = timeSlotColMap[timeSlotStr];

      if (row && col) {
        planningSheet.getRange(row, col).setValue("BOOKED");
        bookedCount++;
      } else {
        skippedCount++;
        if (!row) {
        } else if (!col) {
        }
      }
    }
  } catch (e) {
    throw e;
  }
}

/**
 * Syncs planningA dates with planningB
 * Only dates with maxSlots > 0 in planningB will exist in planningA
 * Removes dates from planningA that don't exist in planningB (or have maxSlots = 0)
 * Adds dates to planningA that exist in planningB with maxSlots > 0
 */
function syncPlanningAWithPlanningB() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const planningASheet = initializePlanningASheet();
    const planningBSheet = ss.getSheetByName("planningB");

    if (!planningBSheet) {
      return { success: false, message: "planningB sheet not found" };
    }

    // Get all dates from planningB with maxSlots > 0
    const planningBData = planningBSheet.getDataRange().getValues();
    const validDatesFromB = new Set();

    for (let i = 1; i < planningBData.length; i++) {
      const dateValue = planningBData[i][0];
      const maxSlots = parseInt(planningBData[i][1]) || 0;

      if (!dateValue || maxSlots <= 0) continue;

      let dateStr = "";
      if (dateValue instanceof Date) {
        dateStr = Utilities.formatDate(
          dateValue,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd",
        );
      } else {
        dateStr = dateValue.toString().trim();
      }

      if (dateStr) {
        validDatesFromB.add(dateStr);
      }
    }

    // Get current dates in planningA
    const planningAData = planningASheet.getDataRange().getValues();
    const currentDatesInA = new Map(); // dateStr -> rowIndex

    for (let i = 1; i < planningAData.length; i++) {
      const dateValue = planningAData[i][0];
      if (!dateValue) continue;

      let dateStr = "";
      if (dateValue instanceof Date) {
        dateStr = Utilities.formatDate(
          dateValue,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd",
        );
      } else {
        dateStr = dateValue.toString().trim();
      }

      if (dateStr) {
        currentDatesInA.set(dateStr, i + 1); // +1 for 1-indexed rows
      }
    }

    // Find dates to remove (in planningA but not in planningB with maxSlots > 0)
    const datesToRemove = [];
    for (const [dateStr, rowIndex] of currentDatesInA) {
      if (!validDatesFromB.has(dateStr)) {
        datesToRemove.push({ dateStr, rowIndex });
      }
    }

    // Remove dates from planningA (delete rows from bottom to top to avoid index shifting)
    datesToRemove.sort((a, b) => b.rowIndex - a.rowIndex);
    for (const item of datesToRemove) {
      planningASheet.deleteRow(item.rowIndex);
    }

    // Find dates to add (in planningB but not in planningA)
    const datesToAdd = [];
    for (const dateStr of validDatesFromB) {
      if (!currentDatesInA.has(dateStr)) {
        datesToAdd.push(dateStr);
      }
    }

    // Add missing dates to planningA
    if (datesToAdd.length > 0) {
      // Sort dates chronologically
      datesToAdd.sort();

      // Get headers to know how many columns we need
      const headers = planningASheet
        .getRange(1, 1, 1, planningASheet.getLastColumn())
        .getValues()[0];
      const totalColumns = headers.length;

      for (const dateStr of datesToAdd) {
        // Create a new row with the date and empty time slots
        const newRow = [dateStr];
        for (let i = 1; i < totalColumns; i++) {
          newRow.push("");
        }
        planningASheet.appendRow(newRow);
      }
    }

    // Sort planningA by date (optional but keeps it organized)
    if (planningASheet.getLastRow() > 2) {
      const dataRange = planningASheet.getRange(
        2,
        1,
        planningASheet.getLastRow() - 1,
        planningASheet.getLastColumn(),
      );
      dataRange.sort(1); // Sort by column A (Date)
    }

    return {
      success: true,
      removed: datesToRemove.length,
      added: datesToAdd.length,
      message: "Sync completed successfully",
    };
  } catch (e) {
    return { success: false, message: "Error syncing: " + e.toString() };
  }
}

/**
 * Ensures a specific date exists in planningA sheet
 * Used when maxSlots is set for a date in planningB
 * @param {string} dateStr - Date in "yyyy-MM-dd" format
 * @return {Object} Success/failure response
 */
function ensureDateInPlanningA(dateStr) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const planningASheet = initializePlanningASheet();

    // Check if date already exists in planningA
    const planningAData = planningASheet.getDataRange().getValues();

    for (let i = 1; i < planningAData.length; i++) {
      const dateValue = planningAData[i][0];
      if (!dateValue) continue;

      let existingDateStr = "";
      if (dateValue instanceof Date) {
        existingDateStr = Utilities.formatDate(
          dateValue,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd",
        );
      } else {
        existingDateStr = dateValue.toString().trim();
      }

      if (existingDateStr === dateStr) {
        return { success: true, message: "Date already exists", existed: true };
      }
    }

    // Date doesn't exist, add it
    const headers = planningASheet
      .getRange(1, 1, 1, planningASheet.getLastColumn())
      .getValues()[0];
    const totalColumns = headers.length;

    // Create a new row with the date and empty time slots
    const newRow = [dateStr];
    for (let i = 1; i < totalColumns; i++) {
      newRow.push("");
    }

    planningASheet.appendRow(newRow);

    // Sort planningA by date to maintain chronological order
    if (planningASheet.getLastRow() > 2) {
      const dataRange = planningASheet.getRange(
        2,
        1,
        planningASheet.getLastRow() - 1,
        planningASheet.getLastColumn(),
      );
      dataRange.sort(1); // Sort by column A (Date)
    }

    return {
      success: true,
      message: "Date added successfully",
      existed: false,
    };
  } catch (e) {
    return { success: false, message: "Error: " + e.toString() };
  }
}

/**
 * Removes a specific date from planningA sheet
 * Used when maxSlots is set to 0 for a date in planningB
 * @param {string} dateStr - Date in "yyyy-MM-dd" format
 * @return {Object} Success/failure response
 */
function removeDateFromPlanningA(dateStr) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const planningASheet = ss.getSheetByName("planningA");

    if (!planningASheet) {
      return { success: true, message: "planningA sheet doesn't exist" };
    }

    // Find and remove the date row
    const planningAData = planningASheet.getDataRange().getValues();

    for (let i = 1; i < planningAData.length; i++) {
      const dateValue = planningAData[i][0];
      if (!dateValue) continue;

      let existingDateStr = "";
      if (dateValue instanceof Date) {
        existingDateStr = Utilities.formatDate(
          dateValue,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd",
        );
      } else {
        existingDateStr = dateValue.toString().trim();
      }

      if (existingDateStr === dateStr) {
        planningASheet.deleteRow(i + 1); // +1 for 1-indexed
        return { success: true, message: "Date removed successfully" };
      }
    }

    return { success: true, message: "Date not found in planningA" };
  } catch (e) {
    return { success: false, message: "Error: " + e.toString() };
  }
}

/**
 * Gets available time slots from planningA for a specific date
 * Checks planningB for maxSlots and limits returned slots to (maxSlots - bookedCount)
 * @param {string} selectedDate - Date in yyyy-MM-dd format
 * @return {Object} Success/failure response with available slots array
 */
function getAvailableSlotsFromPlanningA(selectedDate) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // Step 1: Check planningB for this date's RAA (Remaining Available Appointments)
    const planningBSheet = ss.getSheetByName("planningB");
    let maxSlots = 0;

    if (planningBSheet) {
      const planningBData = planningBSheet.getDataRange().getValues();

      for (let i = 1; i < planningBData.length; i++) {
        const dateValue = planningBData[i][0];
        if (!dateValue) continue;

        let dateStr = "";
        if (dateValue instanceof Date) {
          dateStr = Utilities.formatDate(
            dateValue,
            Session.getScriptTimeZone(),
            "yyyy-MM-dd",
          );
        } else {
          dateStr = dateValue.toString().trim();
        }

        if (dateStr === selectedDate) {
          // Use RAA (column F, index 5) instead of maxSlots (column B, index 1)
          maxSlots = parseInt(planningBData[i][5]) || 0;
          break;
        }
      }
    }

    // If maxSlots is 0 or date not found in planningB, return empty
    if (maxSlots <= 0) {
      return {
        success: true,
        slots: [],
        message: "No slots available. RAA not set for this date.",
        maxSlots: 0,
        bookedCount: 0,
        remainingSlots: 0,
      };
    }

    // Step 2: Get planningA sheet
    let planningSheet = ss.getSheetByName("planningA");

    if (!planningSheet) {
      initializePlanningASheet();
      planningSheet = ss.getSheetByName("planningA");
    }

    const planningData = planningSheet.getDataRange().getValues();
    let planningHeaders = planningData[0];

    // Step 3: Find the row for the selected date in planningA
    let dateRow = null;
    for (let i = 1; i < planningData.length; i++) {
      const dateValue = planningData[i][0];
      let dateStr = "";

      if (dateValue instanceof Date) {
        dateStr = Utilities.formatDate(
          dateValue,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd",
        );
      } else if (dateValue) {
        dateStr = dateValue.toString().trim();
      }

      if (dateStr === selectedDate) {
        dateRow = planningData[i];
        break;
      }
    }

    // If date not found in planningA, ensure it exists (since it exists in planningB with maxSlots > 0)
    if (!dateRow) {
      ensureDateInPlanningA(selectedDate);

      // Re-fetch the data
      const newPlanningData = planningSheet.getDataRange().getValues();
      for (let i = 1; i < newPlanningData.length; i++) {
        const dateValue = newPlanningData[i][0];
        let dateStr = "";

        if (dateValue instanceof Date) {
          dateStr = Utilities.formatDate(
            dateValue,
            Session.getScriptTimeZone(),
            "yyyy-MM-dd",
          );
        } else if (dateValue) {
          dateStr = dateValue.toString().trim();
        }

        if (dateStr === selectedDate) {
          dateRow = newPlanningData[i];
          break;
        }
      }

      // If still not found, return all slots up to maxSlots since none are booked
      if (!dateRow) {
        const allSlots = [];
        for (let hour = 9; hour < 18; hour++) {
          for (let minute = 0; minute < 60; minute += 10) {
            const timeStr =
              (hour < 10 ? "0" : "") +
              hour +
              ":" +
              (minute < 10 ? "0" : "") +
              minute;
            allSlots.push(timeStr);
            if (allSlots.length >= maxSlots) break;
          }
          if (allSlots.length >= maxSlots) break;
        }
        return {
          success: true,
          slots: allSlots,
          maxSlots: maxSlots,
          bookedCount: 0,
          remainingSlots: maxSlots,
        };
      }
    }

    // Step 4: Count booked slots and collect available slots
    const availableSlots = [];
    let bookedCount = 0;
    const maxCol = Math.min(planningHeaders.length, dateRow.length);

    for (let col = 1; col < maxCol; col++) {
      let headerValue = planningHeaders[col];
      const cellValue = dateRow[col];

      if (!headerValue) continue;

      // Normalize header to a time-slot label (HH:MM)
      let slotLabel = "";
      if (headerValue instanceof Date) {
        slotLabel = Utilities.formatDate(
          headerValue,
          Session.getScriptTimeZone(),
          "HH:mm",
        );
      } else {
        const raw = headerValue.toString().trim();
        const m = raw.match(/(\d{1,2}:\d{2})/);
        if (m) {
          const parts = m[1].split(":");
          slotLabel = parts[0].padStart(2, "0") + ":" + parts[1];
        }
      }

      if (!slotLabel) continue;

      // Check if cell is booked
      const isBooked = cellValue && cellValue.toString().trim() === "BOOKED";

      if (isBooked) {
        bookedCount++;
      } else {
        // Cell is empty/available
        availableSlots.push(slotLabel);
      }
    }

    // Step 5: Use RAA directly as the limit for available slots
    // RAA (Remaining Available Appointments) already represents the number of slots we should show
    const remainingSlots = maxSlots; // maxSlots is actually RAA from column E

    // Sort slots chronologically and return only the first N (where N = RAA)
    availableSlots.sort();
    const limitedSlots = availableSlots.slice(0, remainingSlots);

    return {
      success: true,
      slots: limitedSlots,
      maxSlots: maxSlots,
      bookedCount: bookedCount,
      remainingSlots: remainingSlots,
    };
  } catch (e) {
    return {
      success: false,
      message: "Error getting available slots: " + e.toString(),
      slots: [],
    };
  }
}

/**
 * Gets the count of waiting list appointments for a specific date
 * @param {string} dateStr - Date in "yyyy-MM-dd" format
 * @return {Object} Success/failure response with waiting list count
 */
function getWaitingListCount(dateStr) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentSheet = ss.getSheetByName("appointment");

    if (!appointmentSheet) {
      return { success: true, count: 0 };
    }

    const data = appointmentSheet.getDataRange().getValues();
    const headers = data[0];

    // Find column indices - try multiple variations
    let dateColIndex = headers.indexOf("AppointmentDate");
    if (dateColIndex === -1) dateColIndex = headers.indexOf("Appointment Date");
    if (dateColIndex === -1) dateColIndex = 1; // Column B (default)

    let typeColIndex = headers.indexOf("AppointmentType");
    if (typeColIndex === -1) typeColIndex = headers.indexOf("Appointment Type");
    if (typeColIndex === -1) typeColIndex = 8; // Column I (default)

    const deletedOnIndex = headers.indexOf("Deleted On");

    if (dateColIndex === -1 || typeColIndex === -1) {
      return { success: true, count: 0 };
    }

    let waitingListCount = 0;

    for (let i = 1; i < data.length; i++) {
      const row = data[i];

      // Skip deleted appointments
      if (deletedOnIndex !== -1 && row[deletedOnIndex]) {
        continue;
      }

      // Check date
      const appointmentDate = row[dateColIndex];
      let rowDateStr = "";

      if (appointmentDate instanceof Date) {
        rowDateStr = Utilities.formatDate(
          appointmentDate,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd",
        );
      } else if (appointmentDate) {
        rowDateStr = appointmentDate.toString().trim().substring(0, 10);
      }

      if (rowDateStr !== dateStr) {
        continue;
      }

      // Check if appointment type is WAITING LIST (handle variations)
      const appointmentType = row[typeColIndex]
        ? row[typeColIndex].toString().trim().toUpperCase()
        : "";
      // Match "WAITING LIST" or "WAITINGLIST" (without space)
      if (
        appointmentType === "WAITING LIST" ||
        appointmentType === "WAITINGLIST"
      ) {
        waitingListCount++;
      }
    }

    return {
      success: true,
      count: waitingListCount,
      date: dateStr,
    };
  } catch (e) {
    return { success: false, message: "Error: " + e.toString(), count: 0 };
  }
}

/**
 * Checks if a waiting list appointment can be added for a specific date
 * Waiting list limit = ceil(maxSlots * 0.15)
 * @param {string} dateStr - Date in "yyyy-MM-dd" format
 * @return {Object} Success/failure response with availability status
 */
function checkWaitingListLimit(dateStr) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const planningBSheet = ss.getSheetByName("planningB");

    // Get maxSlots for the date
    let maxSlots = 0;

    if (planningBSheet) {
      const planningBData = planningBSheet.getDataRange().getValues();

      for (let i = 1; i < planningBData.length; i++) {
        const dateValue = planningBData[i][0];
        if (!dateValue) continue;

        let rowDateStr = "";
        if (dateValue instanceof Date) {
          rowDateStr = Utilities.formatDate(
            dateValue,
            Session.getScriptTimeZone(),
            "yyyy-MM-dd",
          );
        } else {
          rowDateStr = dateValue.toString().trim();
        }

        if (rowDateStr === dateStr) {
          maxSlots = parseInt(planningBData[i][1]) || 0;
          break;
        }
      }
    }

    // If no maxSlots set, don't allow waiting list
    if (maxSlots <= 0) {
      return {
        success: true,
        allowed: false,
        message:
          "No slots configured for this date. Cannot add to waiting list.",
        maxSlots: 0,
        waitingListLimit: 0,
        currentWaitingListCount: 0,
      };
    }

    // Get waiting list percentage from settings
    const settingsResult = getWaitingListPercentage();
    const percentage =
      settingsResult.percentage || DEFAULT_WAITING_LIST_PERCENTAGE;

    // Calculate waiting list limit (percentage of maxSlots, rounded up)
    const waitingListLimit = Math.ceil(maxSlots * (percentage / 100));

    // Get current waiting list count
    const waitingListResult = getWaitingListCount(dateStr);
    const currentWaitingListCount = waitingListResult.count || 0;

    // Check if we can add more
    const allowed = currentWaitingListCount < waitingListLimit;
    const remainingWaitingSlots = Math.max(
      0,
      waitingListLimit - currentWaitingListCount,
    );

    return {
      success: true,
      allowed: allowed,
      message: allowed
        ? "Waiting list available. " +
          remainingWaitingSlots +
          " spots remaining."
        : "Waiting list is full for this date. Maximum " +
          waitingListLimit +
          " waiting list appointments allowed.",
      maxSlots: maxSlots,
      waitingListLimit: waitingListLimit,
      currentWaitingListCount: currentWaitingListCount,
      remainingWaitingSlots: remainingWaitingSlots,
    };
  } catch (e) {
    return {
      success: false,
      allowed: false,
      message: "Error checking waiting list limit: " + e.toString(),
    };
  }
}

/**
 * Returns combined WL and slot capacity status for a date.
 * Used by DayOverview to gate the "WAITING LIST" option in edit mode.
 * @param {string} dateStr - Date in "yyyy-MM-dd" format
 * @param {string} sessionToken - Session token for authentication
 */
function getDateCapacityStatus(dateStr, sessionToken) {
  try {
    const username = getSessionUsername(sessionToken);
    if (!username) {
      return { success: false, message: "Invalid session." };
    }

    const wlCheck = checkWaitingListLimit(dateStr);
    const stats   = updatePlanningBStats(dateStr);

    return {
      success:          true,
      wlAllowed:        wlCheck.allowed || false,
      wlCount:          wlCheck.currentWaitingListCount || 0,
      wlLimit:          wlCheck.waitingListLimit || 0,
      remainingWlSlots: wlCheck.remainingWaitingSlots || 0,
      taa:              (stats && stats.taa)      || 0,
      maxSlots:         (stats && stats.maxSlots) || 0,
      raa:              (stats && stats.raa)      || 0,
    };
  } catch (e) {
    return { success: false, message: "Error getting capacity status: " + e.toString() };
  }
}

/**
 * Sets up a daily time-based trigger to update planningA sheet
 */
function setupPlanningAUpdateTrigger() {
  try {
    // Delete existing triggers for this function
    const triggers = ScriptApp.getProjectTriggers();
    triggers.forEach(function (trigger) {
      if (
        trigger.getHandlerFunction() === "updatePlanningASheetFromAppointments"
      ) {
        ScriptApp.deleteTrigger(trigger);
      }
    });

    // Create new daily trigger (runs at 2 AM)
    ScriptApp.newTrigger("updatePlanningASheetFromAppointments")
      .timeBased()
      .everyDays(1)
      .atHour(2)
      .create();

    return { success: true, message: "Trigger created successfully" };
  } catch (e) {
    return {
      success: false,
      message: "Error setting up trigger: " + e.toString(),
    };
  }
}

/**
 * Function called by daily trigger to update planningA sheet from appointments
 */
function updatePlanningASheetFromAppointments() {
  try {
    // Step 0: Auto-update maxSlots in planningB for future dates
    // This runs FIRST to ensure planningB has default values populated
    const autoUpdateResult = autoUpdatePlanningBMaxSlots();
    if (autoUpdateResult.success) {
      Logger.log(
        "Auto-update completed: " +
          autoUpdateResult.updatedCount +
          " dates updated",
      );
    } else {
      Logger.log("Auto-update failed: " + autoUpdateResult.message);
    }

    // Step 1: Sync dates from planningB to planningA
    // This ensures planningA only has dates with maxSlots > 0 in planningB
    const syncResult = syncPlanningAWithPlanningB();
    if (syncResult.success) {
      Logger.log("Sync completed successfully");
    } else {
      Logger.log("Sync failed: " + syncResult.message);
    }

    // Step 2: Update BOOKED slots from appointment sheet
    updatePlanningASheet();
  } catch (e) {
    Logger.log(
      "Error in updatePlanningASheetFromAppointments: " + e.toString(),
    );
  }
}

//Book Appointment select Doctor
function getDoctors() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("DoctorAvailability");
    if (!sheet) {
      return { success: false, message: "DoctorAvailability sheet not found." };
    }

    // Get values from column A, starting at A2
    var data = sheet.getRange("A2:A" + sheet.getLastRow()).getValues();
    var doctors = [];
    for (var i = 0; i < data.length; i++) {
      var doc = data[i][0];
      if (doc && doc.toString().trim() !== "") {
        doctors.push(doc.toString().trim());
      }
    }

    return { success: true, doctors: doctors };
  } catch (error) {
    return { success: false, message: error.toString() };
  }
}

// Book Appointment: Returns an array of holiday dates (formatted as "yyyy-MM-dd") from the Holidays sheet (A2:A)
function getHolidays() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Holidays");
    if (!sheet) {
      return { success: false, message: "Holidays sheet not found." };
    }
    var data = sheet.getRange("A2:A" + sheet.getLastRow()).getValues();
    var holidays = data
      .filter(function (row) {
        return row[0];
      })
      .map(function (row) {
        return Utilities.formatDate(
          new Date(row[0]),
          Session.getScriptTimeZone(),
          "yyyy-MM-dd",
        );
      });
    return { success: true, holidays: holidays };
  } catch (error) {
    return { success: false, message: error.toString() };
  }
}

// Available time slot

// Convert minutes to a "HH:mm" string (24‑hour format)
function formatTime(totalMinutes) {
  var hours = Math.floor(totalMinutes / 60);
  var minutes = totalMinutes % 60;
  return ("0" + hours).slice(-2) + ":" + ("0" + minutes).slice(-2);
}

// Convert a time string ("HH:mm") to minutes past midnight
function timeStringToMinutes(timeStr) {
  try {
    const parts = timeStr.trim().split(":");
    if (parts.length !== 2) return NaN;
    const hours = parseInt(parts[0], 10),
      minutes = parseInt(parts[1], 10);
    return isNaN(hours) || isNaN(minutes) ? NaN : hours * 60 + minutes;
  } catch (e) {
    return NaN;
  }
}

function getDoctorAvailabilityRanges(doctor, dayOfWeek) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("DoctorAvailability");
  var data = sheet.getDataRange().getValues();
  var ranges = [];
  // Assume first row is header with day names (Monday, Tuesday, etc.)
  var headers = data[0];
  var dayIndex = headers.indexOf(dayOfWeek);
  if (dayIndex === -1)
    throw new Error("Day not found in DoctorAvailability header.");

  // Find the row for the given doctor (assume doctor name is in Column A)
  for (var i = 1; i < data.length; i++) {
    if (data[i][0].toString().trim() === doctor) {
      var cellValue = data[i][dayIndex];
      if (cellValue) {
        // Expect a string like "09:00-12:00, 13:00-17:30"
        ranges = cellValue.split(",").map(function (r) {
          return r.trim();
        });
      }
      break;
    }
  }
  return ranges;
}

function getBookedSlots(doctor, dateString) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("appointment");
  var data = sheet.getDataRange().getValues();
  var booked = [];

  // Assume: Date is in Column B, Time Slot in Column C, Doctor in Column J; first row is header.
  for (var i = 1; i < data.length; i++) {
    var rowDate = Utilities.formatDate(
      new Date(data[i][1]),
      Session.getScriptTimeZone(),
      "yyyy-MM-dd",
    );
    var rowDoctor = data[i][9] ? data[i][9].toString().trim() : "";

    // Format the raw time slot into "HH:mm" format
    var timeSlotRaw = data[i][2];
    var formattedTime = Utilities.formatDate(
      new Date(timeSlotRaw),
      Session.getScriptTimeZone(),
      "HH:mm",
    );

    if (rowDate === dateString && rowDoctor === doctor) {
      booked.push(formattedTime);
    }
  }

  return booked;
}

function getDoctorExceptionRanges(doctor, dateString) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("DoctorAvailabilityExceptions");
    if (!sheet) return [];

    var data = sheet.getDataRange().getValues();
    var exceptions = [];

    for (var i = 1; i < data.length; i++) {
      // Column 0: Doctor, Column 1: Date, Column 2: From Time, Column 3: To Time
      var rowDoctor = data[i][0]?.toString().trim() || "";
      var rowDate = data[i][1]
        ? Utilities.formatDate(
            new Date(data[i][1]),
            Session.getScriptTimeZone(),
            "yyyy-MM-dd",
          )
        : "";

      if (rowDoctor === doctor && rowDate === dateString) {
        // Format times consistently as "HH:mm"
        var fromTime = formatTimeString(data[i][2]);
        var toTime = formatTimeString(data[i][3]);

        if (fromTime && toTime) {
          exceptions.push(fromTime + "-" + toTime);
        }
      }
    }
    return exceptions;
  } catch (e) {
    return [];
  }
}

// Helper function to standardize time strings
function formatTimeString(timeInput) {
  if (!timeInput) return "";

  // Handle cases where time might be a string ("9:00") or Date object
  var timeStr =
    typeof timeInput === "string"
      ? timeInput
      : Utilities.formatDate(timeInput, Session.getScriptTimeZone(), "HH:mm");

  // Ensure 24-hour format with leading zero
  var parts = timeStr.split(":");
  if (parts.length === 2) {
    var hours = parts[0].padStart(2, "0");
    var minutes = parts[1].padStart(2, "0");
    return hours + ":" + minutes;
  }
  return "";
}

/*function getDoctorExceptionRanges(doctor, dateString) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("DoctorAvailabilityExceptions");
  var data = sheet.getDataRange().getValues();
  var exceptions = [];
  // Assume first row is header.
  for (var i = 1; i < data.length; i++) {
    if (data[i][0].toString().trim() === doctor && 
        Utilities.formatDate(new Date(data[i][1]), Session.getScriptTimeZone(), "yyyy-MM-dd") === dateString) {
      var fromTime = data[i][2]; // From Time (Column C)
      var toTime = data[i][3];   // To Time (Column D)
      if (fromTime && toTime) {
        exceptions.push(fromTime + "-" + toTime);
      }
    }
  }
  return exceptions;
}
*/
function isSlotWithinRanges(slot, ranges) {
  if (!slot || !ranges || ranges.length === 0) return false;

  var slotMins = timeStringToMinutes(slot);

  for (var i = 0; i < ranges.length; i++) {
    var rangeParts = ranges[i].split("-");
    if (rangeParts.length !== 2) continue;

    var startTime = rangeParts[0].trim();
    var endTime = rangeParts[1].trim();

    var startMins = timeStringToMinutes(startTime);
    var endMins = timeStringToMinutes(endTime);

    if (slotMins >= startMins && slotMins < endMins) {
      return true;
    }
  }
  return false;
}

// Server-side function in your .gs file:
function getDoctorMonthlyData(doctor, monthKey, filterDoctor) {
  // Parse monthKey (e.g., "2025-03") to get year and month.
  var parts = monthKey.split("-");
  var year = parseInt(parts[0], 10);
  var month = parseInt(parts[1], 10) - 1; // 0-indexed

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("appointment");
  var data = sheet.getDataRange().getValues();
  var bookedSlots = {};
  var exceptions = {};

  // Loop through appointments (assuming first row is header).
  for (var i = 1; i < data.length; i++) {
    var apptDate = new Date(data[i][1]);
    var formattedDate = Utilities.formatDate(
      apptDate,
      Session.getScriptTimeZone(),
      "yyyy-MM-dd",
    );
    // Check if appointment is for the specified doctor and month.
    var appointmentDoctor = data[i][9].toString().trim();
    if (formattedDate.indexOf(monthKey) === 0) {
      // If filterDoctor is provided, only include appointments for that doctor
      if (!filterDoctor || appointmentDoctor === filterDoctor) {
        // If looking for specific doctor data, match exactly; otherwise include all
        if (!doctor || appointmentDoctor === doctor) {
          // Assuming booked slot is in column C in "HH:mm" format.
          if (!bookedSlots[formattedDate]) {
            bookedSlots[formattedDate] = [];
          }
          bookedSlots[formattedDate].push(data[i][2].toString().trim());
        }
      }
    }
  }

  // Similarly, you can fetch exception ranges from the DoctorAvailabilityExceptions sheet.
  var exceptionSheet = ss.getSheetByName("DoctorAvailabilityExceptions");
  if (exceptionSheet) {
    var exData = exceptionSheet.getDataRange().getValues();
    for (var j = 1; j < exData.length; j++) {
      var exceptionDoctor = exData[j][0].toString().trim();
      // Filter exceptions by doctor if filterDoctor is provided
      if (!filterDoctor || exceptionDoctor === filterDoctor) {
        if (!doctor || exceptionDoctor === doctor) {
          var exDate = new Date(exData[j][1]);
          var formattedExDate = Utilities.formatDate(
            exDate,
            Session.getScriptTimeZone(),
            "yyyy-MM-dd",
          );
          if (formattedExDate.indexOf(monthKey) === 0) {
            if (!exceptions[formattedExDate]) {
              exceptions[formattedExDate] = [];
            }
            var fromTime = exData[j][2];
            var toTime = exData[j][3];
            if (fromTime && toTime) {
              var fromStr = Utilities.formatDate(
                new Date(fromTime),
                Session.getScriptTimeZone(),
                "HH:mm",
              );
              var toStr = Utilities.formatDate(
                new Date(toTime),
                Session.getScriptTimeZone(),
                "HH:mm",
              );
              exceptions[formattedExDate].push(fromStr + "-" + toStr);
            }
          }
        }
      }
    }
  }

  return { bookedSlots: bookedSlots, exceptions: exceptions };
}

/**
 * Return every doctor's weekly availability so
 * Month Overview can compute total slots per day.
 */
function getDoctorAvailabilityDataToday(doctor) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("DoctorAvailability");
    if (!sheet) {
      throw new Error("DoctorAvailability sheet not found.");
    }

    var data = sheet.getDataRange().getValues();
    var headers = data[0]; // ["Doctor","Monday",…,"Saturday"]
    var doctors = [];

    // build one object per doctor
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var doctorName = row[0];

      // Filter by doctor if provided
      if (doctor && doctorName !== doctor) {
        continue;
      }

      var doc = { name: doctorName };
      for (var j = 1; j < headers.length; j++) {
        doc[headers[j]] = row[j]; // e.g. doc["Monday"] = "09:00-12:00"
      }
      doctors.push(doc);
    }

    return { success: true, doctors: doctors };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

function getDoctorAvailabilityData(doctor, selectedDateStr) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("DoctorAvailability");
    if (!sheet) {
      throw new Error("DoctorAvailability sheet not found.");
    }

    var data = sheet.getDataRange().getValues();
    var headers = data[0]; // Assumes first row contains day names
    var availabilityRanges = [];

    // Determine the day of the week for the selected date
    var selectedDate = new Date(selectedDateStr);
    var dayNames = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    var dayOfWeek = dayNames[selectedDate.getDay()];

    // Find the row for the given doctor (assuming doctor name is in Column A)
    for (var i = 1; i < data.length; i++) {
      if (data[i][0].toString().trim() === doctor) {
        var cellValue = data[i][headers.indexOf(dayOfWeek)];
        if (cellValue) {
          // Expect a string like "10:00-12:00, 13:00-17:30"
          availabilityRanges = cellValue
            .toString()
            .split(",")
            .map(function (item) {
              return item.trim();
            });
        }
        break;
      }
    }

    // Get exception ranges for this doctor and date
    var exceptions = getDoctorExceptionRanges(doctor, selectedDateStr);

    return {
      success: true,
      availability: availabilityRanges,
      exceptions: exceptions,
    };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

/**
 * Returns allowed time slots for a given doctor, appointment type, and appointment date,
 * factoring in day codes (e.g., "M", "Tu") and offset logic.
 */

/**
 * Returns allowed time slots for a given doctor, appointment type, and appointment date,
 * factoring in day codes (e.g., "M", "Tu") and offset logic.
 */
function getAllowedSlots(
  doctor,
  appointmentType,
  appointmentDateStr,
  slotInterval = 10,
) {
  try {
    // Validate inputs
    if (!doctor || !appointmentType || !appointmentDateStr) {
      throw new Error("Missing required parameters");
    }

    var appointmentDate = new Date(appointmentDateStr);
    if (isNaN(appointmentDate.getTime())) {
      throw new Error("Invalid date format. Expected YYYY-MM-DD");
    }

    var today = new Date();
    today.setHours(0, 0, 0, 0);
    appointmentDate.setHours(0, 0, 0, 0);

    // Check if appointment is today
    var isToday = appointmentDate.getTime() === today.getTime();

    // Calculate days between today and appointment
    var diffDays = Math.floor(
      (appointmentDate - today) / (1000 * 60 * 60 * 24),
    );

    // Get day name and code
    var dayNames = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    var dayOfWeek = dayNames[appointmentDate.getDay()];
    var selectedDayCode = getDayCode(dayOfWeek);

    // 1. Get doctor's default availability
    var availabilityResp = getDoctorAvailabilityData(
      doctor,
      appointmentDateStr,
    );
    if (!availabilityResp.success) {
      throw new Error(
        "Error fetching doctor's availability: " + availabilityResp.message,
      );
    }

    // getDoctorAvailabilityData returns availability as an array, not an object with day keys
    var defaultIntervals = availabilityResp.availability || [];

    // Convert each range into time slots
    var defaultSlots = [];
    defaultIntervals.forEach(function (range) {
      var parts = range.split("-");
      if (parts.length < 2) return;

      var startTime = parts[0].trim();
      var endTime = parts[1].trim();
      var startMins = timeStringToMinutes(startTime);
      var endMins = timeStringToMinutes(endTime);

      for (var t = startMins; t < endMins; t += parseInt(slotInterval)) {
        defaultSlots.push(formatTime(t));
      }
    });

    // 2. Remove Booked Slots
    var booked = getBookedSlots(doctor, appointmentDateStr);

    var availableSlots = defaultSlots.filter(function (slot) {
      return booked.indexOf(slot) === -1;
    });

    // 3. Remove Exception Ranges
    var exceptions = getDoctorExceptionRanges(doctor, appointmentDateStr);

    availableSlots = availableSlots.filter(function (slot) {
      var slotMins = timeStringToMinutes(slot);
      var isBlocked = false;

      for (var i = 0; i < exceptions.length; i++) {
        var exParts = exceptions[i].split("-");
        if (exParts.length < 2) continue;

        var exStart = timeStringToMinutes(exParts[0]);
        var exEnd = timeStringToMinutes(exParts[1]);

        if (slotMins >= exStart && slotMins < exEnd) {
          isBlocked = true;
          break;
        }
      }
      return !isBlocked;
    });

    // 4. Type-specific filtering
    appointmentType = appointmentType.toUpperCase();

    // 4A. Waiting List - no slots
    if (appointmentType === "WAITING LIST") {
      return { success: true, allowedSlots: [] };
    }

    // 4B. General Appointment filtering
    if (appointmentType === "GENERAL") {
      var disallowed = getDisallowedIntervals();
      availableSlots = availableSlots.filter(function (slot) {
        var slotMins = timeStringToMinutes(slot);
        var isAllowed = true;

        for (var i = 0; i < disallowed.length; i++) {
          var d = disallowed[i];
          // Check for both specific day and daily ("D") intervals
          if (d.day !== selectedDayCode && d.day !== "D") continue;

          // Block if booking is more than the specified days
          if (diffDays > d.days) {
            var dStart = timeStringToMinutes(d.startTime);
            var dEnd = timeStringToMinutes(d.endTime);

            if (slotMins >= dStart && slotMins < dEnd) {
              isAllowed = false;
              break;
            }
          }
        }
        return isAllowed;
      });
      return { success: true, allowedSlots: availableSlots };
    }

    // 4C. Specialized Appointment filtering (HFA, ROP, DILATATION, etc.)
    var specialized = getSpecializedIntervals(appointmentType);

    // If no specialized intervals are defined, return all available slots
    if (specialized.length === 0) {
      return { success: true, allowedSlots: availableSlots };
    }
    var specializedSlots = [];
    specialized.forEach(function (interval) {
      // Check for both specific day and daily ("D") intervals
      if (interval.day !== selectedDayCode && interval.day !== "D") return;
      // Ensure days is a number
      var days = typeof interval.days === "number" ? interval.days : 0;

      // If days is -1, the slot is only available today
      // If days is 0, the slot is always available
      // If days is N, the slot is only available when booking N or fewer days in advance
      if (days === -1) {
        if (isToday) {
          var startMins = timeStringToMinutes(interval.startTime);
          var endMins = timeStringToMinutes(interval.endTime);

          for (var t = startMins; t < endMins; t += parseInt(slotInterval)) {
            specializedSlots.push(formatTime(t));
          }
        }
      } else if (days === 0 || diffDays <= days) {
        var startMins = timeStringToMinutes(interval.startTime);
        var endMins = timeStringToMinutes(interval.endTime);

        for (var t = startMins; t < endMins; t += parseInt(slotInterval)) {
          specializedSlots.push(formatTime(t));
        }
      }
    });

    // Intersect available slots with specialized slots
    availableSlots = availableSlots.filter(function (slot) {
      var isInSpecialized = specializedSlots.indexOf(slot) !== -1;
      return isInSpecialized;
    });

    // After getting booked slots, check for fixed slots
    const fixedSlots = [];
    for (const slot of availableSlots) {
      if (isSlotFixed(doctor, appointmentDateStr, slot)) {
        fixedSlots.push(slot);
      }
    }

    // Return both available and fixed slots
    return {
      success: true,
      allowedSlots: availableSlots,
      fixedSlots: fixedSlots,
    };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

// Helper function to convert day name to code
function getDayCode(dayName) {
  var map = {
    Sunday: "Su",
    Monday: "M",
    Tuesday: "Tu",
    Wednesday: "W",
    Thursday: "Th",
    Friday: "F",
    Saturday: "Sa",
    Daily: "D", // Add Daily option
  };
  return map[dayName] || "";
}

//helper function to validate times:
function validateTimeInput(timeStr) {
  return /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(timeStr);
}

/**
 * Normalizes appointment date to YYYY-MM-DD format
 * Handles Date objects, ISO strings, and YYYY-MM-DD strings
 * Strips time components if present
 * @param {string|Date} dateValue - Date value to normalize
 * @return {string} Normalized date in YYYY-MM-DD format
 */
function normalizeAppointmentDate(dateValue) {
  try {
    if (!dateValue) {
      throw new Error("Date value is required");
    }

    var date;

    // Handle Date objects
    if (dateValue instanceof Date) {
      date = dateValue;
    }
    // Handle string inputs
    else if (typeof dateValue === "string") {
      var trimmedDate = dateValue.trim();

      // Check if already in YYYY-MM-DD format (no time component)
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmedDate)) {
        return trimmedDate;
      }

      // Handle ISO strings or strings with time components
      // Extract just the date part if it contains 'T' or space
      if (trimmedDate.includes("T") || trimmedDate.includes(" ")) {
        var datePart = trimmedDate.split("T")[0].split(" ")[0];
        if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
          return datePart;
        }
      }

      // Try to parse as date
      date = new Date(trimmedDate);
    } else {
      throw new Error("Invalid date type: " + typeof dateValue);
    }

    // Validate the date is valid
    if (isNaN(date.getTime())) {
      throw new Error("Invalid date value: " + dateValue);
    }

    // Format as YYYY-MM-DD
    var year = date.getFullYear();
    var month = ("0" + (date.getMonth() + 1)).slice(-2);
    var day = ("0" + date.getDate()).slice(-2);

    return year + "-" + month + "-" + day;
  } catch (e) {
    throw new Error("Failed to normalize date: " + e.message);
  }
}

/**
 * Normalizes time slot to HH:MM format (24-hour)
 * Handles various time formats (12-hour, 24-hour, with seconds)
 * Strips date components if present
 * @param {string} timeValue - Time value to normalize
 * @return {string} Normalized time in HH:MM format
 */
function normalizeTimeSlot(timeValue) {
  try {
    if (!timeValue) {
      throw new Error("Time value is required");
    }

    var trimmedTime = timeValue.toString().trim();

    // Check if already in HH:MM format
    if (/^\d{2}:\d{2}$/.test(trimmedTime)) {
      return trimmedTime;
    }

    // Strip date component if present (e.g., "2024-12-15 14:30" or "2024-12-15T14:30:00")
    if (trimmedTime.includes("T") || trimmedTime.includes(" ")) {
      var parts = trimmedTime.split("T");
      if (parts.length > 1) {
        trimmedTime = parts[1];
      } else {
        parts = trimmedTime.split(" ");
        if (parts.length > 1) {
          trimmedTime = parts[1];
        }
      }
    }

    // Remove seconds if present (e.g., "14:30:00" -> "14:30")
    if (/^\d{2}:\d{2}:\d{2}$/.test(trimmedTime)) {
      return trimmedTime.substring(0, 5);
    }

    // Handle 12-hour format with AM/PM
    var ampmMatch = trimmedTime.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (ampmMatch) {
      var hours = parseInt(ampmMatch[1]);
      var minutes = ampmMatch[2];
      var period = ampmMatch[3].toUpperCase();

      // Convert to 24-hour format
      if (period === "PM" && hours !== 12) {
        hours += 12;
      } else if (period === "AM" && hours === 12) {
        hours = 0;
      }

      return ("0" + hours).slice(-2) + ":" + minutes;
    }

    // Handle single digit hour format (e.g., "9:30" -> "09:30")
    var singleDigitMatch = trimmedTime.match(/^(\d{1}):(\d{2})$/);
    if (singleDigitMatch) {
      var hour = ("0" + singleDigitMatch[1]).slice(-2);
      return hour + ":" + singleDigitMatch[2];
    }

    // If already in valid HH:MM format, return as is
    if (/^\d{2}:\d{2}$/.test(trimmedTime)) {
      return trimmedTime;
    }

    throw new Error("Unrecognized time format: " + timeValue);
  } catch (e) {
    throw new Error("Failed to normalize time: " + e.message);
  }
}

/**
 * Validates appointment data before storage
 * Validates date format (YYYY-MM-DD) and time format (HH:MM)
 * @param {Object} appointmentData - Appointment data object
 * @return {Object} {valid: boolean, errors: string[]}
 */
function validateAppointmentData(appointmentData) {
  try {
    var errors = [];

    // Validate appointment date
    if (appointmentData.appointmentDate) {
      var dateStr = appointmentData.appointmentDate.toString().trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        errors.push(
          "Invalid appointment date format. Expected format: YYYY-MM-DD (example: 2024-12-15). Received: '" +
            dateStr +
            "'",
        );
      }
    } else {
      errors.push("Appointment date is required but was not provided");
    }

    // Validate time slot (only if not WAITING LIST)
    if (appointmentData.appointmentType !== "WAITING LIST") {
      if (appointmentData.timeSlot) {
        var timeStr = appointmentData.timeSlot.toString().trim();
        if (!/^\d{2}:\d{2}$/.test(timeStr)) {
          errors.push(
            "Invalid time slot format. Expected format: HH:MM in 24-hour notation (example: 14:30). Received: '" +
              timeStr +
              "'",
          );
        }
      } else {
        errors.push(
          "Time slot is required for non-waiting list appointments but was not provided",
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors,
    };
  } catch (e) {
    return {
      valid: false,
      errors: ["Validation error: " + e.message],
    };
  }
}

// Helper function to format minutes as HH:mm
function formatTime(totalMinutes) {
  var hours = Math.floor(totalMinutes / 60);
  var minutes = totalMinutes % 60;
  return ("0" + hours).slice(-2) + ":" + ("0" + minutes).slice(-2);
}

/**
 * Parses a slot string in the format "M-09:20-09:40-0" and returns an object.
 */

function parseSlotData(slotString) {
  var parts = slotString.split("-");
  var days = 0; // Default to 0 if not specified

  // If there's a fourth part, try to parse it as a number
  if (parts.length >= 4) {
    var daysStr = parts[3].trim();
    // Handle special case for -1 (today only)
    if (daysStr === "-1") {
      days = -1;
    } else {
      var parsedDays = parseInt(daysStr);
      days = isNaN(parsedDays) ? 0 : parsedDays;
    }
  }
  return {
    // parts[0] = "M" or "Tu" or "W" ...
    day: parts[0].trim(),
    startTime: parts[1].trim(),
    endTime: parts[2].trim(),
    days: days,
  };
}
/*// ADD: Helper to map day name -> code
function getDayCode(dayName) {
  // Example mapping (adapt to however you store them):
  var map = {
    "Sunday": "Su",
    "Monday": "M",
    "Tuesday": "Tu",
    "Wednesday": "W",
    "Thursday": "Th",
    "Friday": "F",
    "Saturday": "Sa"
  };
  return map[dayName] || ""; 
}
*/

/**
 * Retrieves allowed specialized intervals for the given appointment type from the "generalSettings" sheet.
 * For example, for HFA, the allowed interval might be stored in Column F.
 * Returns an array of objects using parseSlotData.
 */
function getSpecializedIntervals(appointmentType) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("generalSettings");
  if (!sheet) throw new Error("generalSettings sheet not found.");

  var columnMapping = {
    HFA: "F",
    ROP: "G",
    INJECTION: "H",
    "URGENT NEW": "I",
    EMERGENCY: "J",
    DILATION: "K",
    LASER: "L",
    REFERRALS: ["E", "I", "J"],
  };

  var mapping = columnMapping[appointmentType];
  var intervals = [];

  if (!mapping) {
    return intervals;
  }

  function parseIntervalFromCell(cellValue) {
    if (!cellValue) return null;

    var parts = cellValue.toString().split("-");
    if (parts.length < 4) return null;

    var daysStr = parts[3].trim();
    var days;

    // Handle special case for -1 (today only)
    if (daysStr === "-1") {
      days = -1;
    } else {
      var parsedDays = parseInt(daysStr);
      days = isNaN(parsedDays) ? 0 : parsedDays;
    }

    return {
      day: parts[0].trim(),
      startTime: parts[1].trim(),
      endTime: parts[2].trim(),
      days: days,
    };
  }

  if (Array.isArray(mapping)) {
    mapping.forEach(function (col) {
      var data = sheet.getRange(col + "2:" + col + "100").getValues();
      data.forEach(function (row) {
        if (row[0]) {
          var interval = parseIntervalFromCell(row[0]);
          if (interval) intervals.push(interval);
        }
      });
    });
  } else {
    var data = sheet.getRange(mapping + "2:" + mapping + "100").getValues();
    data.forEach(function (row) {
      if (row[0]) {
        var interval = parseIntervalFromCell(row[0]);
        if (interval) intervals.push(interval);
      }
    });
  }
  return intervals;
}

function getAllDoctorLeaveDays(doctor) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("DoctorLeaveDays");
    if (!sheet) {
      return { success: false, message: "DoctorLeaveDays sheet not found." };
    }

    var data = sheet.getDataRange().getValues();
    var leaveDates = [];

    // Start from i=1 to skip header row
    for (var i = 1; i < data.length; i++) {
      // Match doctor in Column A; date in Column B
      if (data[i][0] && data[i][0].toString().trim() === doctor && data[i][1]) {
        var dateVal = new Date(data[i][1]);
        // Only add if parse is successful
        if (!isNaN(dateVal.getTime())) {
          var formatted = Utilities.formatDate(
            dateVal,
            Session.getScriptTimeZone(),
            "yyyy-MM-dd",
          );
          leaveDates.push(formatted);
        }
      }
    }

    return { success: true, leaveDates: leaveDates };
  } catch (error) {
    return { success: false, message: error.toString() };
  }
}
function getDisallowedIntervals() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("generalSettings");
  if (!sheet) throw new Error("generalSettings sheet not found.");

  var data = sheet.getRange("E2:E100").getValues();
  var intervals = [];

  data.forEach(function (row) {
    if (row[0]) {
      // Use parseSlotData to parse the line, e.g., "M-09:20-09:40-4"
      var slot = parseSlotData(row[0].toString());
      intervals.push(slot);
    }
  });

  return intervals;
}

function updateAppointmentDetails(updatedData, sessionToken) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("appointment");
    if (!sheet) {
      return { success: false, message: "Sheet not found." };
    }

    var data = sheet.getDataRange().getValues();
    var headers = data[0];
    var rowIndex = -1;

    // Find the appointment row
    for (var i = 1; i < data.length; i++) {
      if (data[i][0].toString() === updatedData.appointmentId) {
        rowIndex = i;
        break;
      }
    }

    if (rowIndex === -1) {
      return { success: false, message: "Appointment not found." };
    }

    // Guard: if converting to WAITING LIST, enforce the WL limit
    if (updatedData.type && updatedData.type.toUpperCase() === "WAITING LIST") {
      var existingTypeIdx = headers.indexOf("AppointmentType");
      var existingType = (existingTypeIdx !== -1)
        ? data[rowIndex][existingTypeIdx].toString().trim().toUpperCase()
        : "";

      if (existingType !== "WAITING LIST") {
        var apptDateIdx = headers.indexOf("AppointmentDate");
        var apptDateVal = (apptDateIdx !== -1) ? data[rowIndex][apptDateIdx] : null;
        var dateStr = "";
        if (apptDateVal instanceof Date) {
          dateStr = Utilities.formatDate(apptDateVal, Session.getScriptTimeZone(), "yyyy-MM-dd");
        } else if (apptDateVal) {
          dateStr = apptDateVal.toString().trim().substring(0, 10);
        }

        if (dateStr) {
          var wlCheck = checkWaitingListLimit(dateStr);
          if (!wlCheck.allowed) {
            return { success: false, message: wlCheck.message };
          }
        }
      }
    }

    // Guard: if converting FROM WAITING LIST to a regular type, check regular slot availability
    if (updatedData.type && updatedData.type.toUpperCase() !== "WAITING LIST") {
      var existingTypeIdx2 = headers.indexOf("AppointmentType");
      var existingType2 = (existingTypeIdx2 !== -1)
        ? data[rowIndex][existingTypeIdx2].toString().trim().toUpperCase()
        : "";

      if (existingType2 === "WAITING LIST") {
        var apptDateIdx2 = headers.indexOf("AppointmentDate");
        var apptDateVal2 = (apptDateIdx2 !== -1) ? data[rowIndex][apptDateIdx2] : null;
        var dateStr2 = "";
        if (apptDateVal2 instanceof Date) {
          dateStr2 = Utilities.formatDate(apptDateVal2, Session.getScriptTimeZone(), "yyyy-MM-dd");
        } else if (apptDateVal2) {
          dateStr2 = apptDateVal2.toString().trim().substring(0, 10);
        }

        if (dateStr2) {
          var slotStats = updatePlanningBStats(dateStr2);
          if (slotStats && slotStats.maxSlots > 0 && slotStats.raa <= 0) {
            return {
              success: false,
              message: "Maximum appointments (" + slotStats.maxSlots + ") for this day have been allocated. This waiting list patient cannot be moved to a regular slot."
            };
          }
        }
      }
    }

    // Get column indices for the fields to update
    var typeCol = headers.indexOf("AppointmentType");
    var doctorCol = headers.indexOf("Doctor");
    var planCol = headers.indexOf("PlanOfAction");

    // Update the values in the sheet (excluding remarks - handled separately)
    if (typeCol !== -1)
      sheet.getRange(rowIndex + 1, typeCol + 1).setValue(updatedData.type);
    if (doctorCol !== -1)
      sheet.getRange(rowIndex + 1, doctorCol + 1).setValue(updatedData.doctor);
    if (planCol !== -1)
      sheet.getRange(rowIndex + 1, planCol + 1).setValue(updatedData.plan);

    // Add new remark to history if provided
    if (updatedData.remarks && updatedData.remarks.trim() !== "") {
      addRemarkToHistory(
        updatedData.appointmentId,
        updatedData.remarks.trim(),
        sessionToken,
      );
    }

    // Log audit event
    logAuditEvent(
      sessionToken,
      "UPDATE_APPOINTMENT_DETAILS",
      "APPOINTMENT",
      updatedData.appointmentId,
      {
        sheetName: "appointment",
        updatedFields: {
          appointmentType: updatedData.type,
          doctor: updatedData.doctor,
          planOfAction: updatedData.plan,
          remarksAdded: updatedData.remarks ? true : false,
        },
        patientName: data[rowIndex][4] || "",
        mrdNo: data[rowIndex][3] || "",
      },
    );

    return {
      success: true,
      message: "Appointment details updated successfully.",
    };
  } catch (e) {
    return {
      success: false,
      message:
        "An error occurred while updating appointment details: " + e.toString(),
    };
  }
}

/**
 * Update Check-in Time (TimeSlot) for an appointment
 * Automatically calculates and updates Consult Start time
 * Logs the change in AppointmentJourney
 * @param {string} appointmentId - The appointment ID
 * @param {string} timeString - Time in HH:MM format (e.g., "14:30")
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Success status and message
 */
function updateCheckInTime(appointmentId, timeString, sessionToken) {
  try {
    // Get username from session token
    const username = getSessionUsername(sessionToken);
    if (!username) {
      return {
        success: false,
        message: "Invalid session. Please login again.",
      };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentSheet = ss.getSheetByName("appointment");
    if (!appointmentSheet) {
      return { success: false, message: "Appointment sheet not found." };
    }

    const data = appointmentSheet.getDataRange().getValues();
    const headers = data[0];

    // Find the appointment row
    let rowIndex = -1;
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] && data[i][0].toString() === appointmentId) {
        rowIndex = i;
        break;
      }
    }

    if (rowIndex === -1) {
      return { success: false, message: "Appointment not found." };
    }

    // Get column indices
    const appointmentDateCol = headers.indexOf("AppointmentDate");
    const timeSlotCol = headers.indexOf("TimeSlot");
    const consultStartCol = headers.indexOf("Consult Start");
    const planOfActionCol = headers.indexOf("PlanOfAction");

    if (appointmentDateCol === -1 || timeSlotCol === -1) {
      return { success: false, message: "Required columns not found." };
    }

    // Get current values
    const appointmentDate = data[rowIndex][appointmentDateCol];
    const oldTimeSlot = data[rowIndex][timeSlotCol];
    const oldConsultStart =
      consultStartCol !== -1 ? data[rowIndex][consultStartCol] : null;
    const planOfAction =
      planOfActionCol !== -1 ? data[rowIndex][planOfActionCol] : null;

    // Handle empty time string (for Waiting List appointments)
    let normalizedTimeSlot = null;
    let newConsultStart = null;

    // Secondary WL guard: if clearing time (WL conversion), check WL limit before writing.
    // Primary guard is in updateAppointmentDetails; this covers independent calls to this function.
    if (!timeString || timeString.trim() === "") {
      const apptTypeCol2 = headers.indexOf("AppointmentType");
      const currentApptType = (apptTypeCol2 !== -1)
        ? data[rowIndex][apptTypeCol2].toString().trim().toUpperCase()
        : "";

      if (currentApptType !== "WAITING LIST" && currentApptType !== "") {
        let dateStr2 = "";
        const apptDateVal2 = data[rowIndex][appointmentDateCol];
        if (apptDateVal2 instanceof Date) {
          dateStr2 = Utilities.formatDate(apptDateVal2, Session.getScriptTimeZone(), "yyyy-MM-dd");
        } else if (apptDateVal2) {
          dateStr2 = apptDateVal2.toString().trim().substring(0, 10);
        }
        if (dateStr2) {
          const wlCheck2 = checkWaitingListLimit(dateStr2);
          if (!wlCheck2.allowed) {
            return { success: false, message: wlCheck2.message };
          }
        }
      }
    }

    if (!timeString || timeString.trim() === "") {
      // Empty time string - clear TimeSlot and Consult Start (for Waiting List)
      appointmentSheet.getRange(rowIndex + 1, timeSlotCol + 1).setValue("");
      if (consultStartCol !== -1) {
        appointmentSheet
          .getRange(rowIndex + 1, consultStartCol + 1)
          .setValue("");
      }

      // Format times for journey logging
      const oldTimeFormatted = oldTimeSlot
        ? typeof oldTimeSlot === "string"
          ? oldTimeSlot
          : Utilities.formatDate(
              new Date(oldTimeSlot),
              Session.getScriptTimeZone(),
              "HH:mm",
            )
        : "N/A";
      const oldConsultFormatted = oldConsultStart
        ? typeof oldConsultStart === "string"
          ? oldConsultStart
          : Utilities.formatDate(
              new Date(oldConsultStart),
              Session.getScriptTimeZone(),
              "HH:mm",
            )
        : "N/A";

      // Log journey entry
      logAppointmentJourney(
        appointmentId,
        "checkin_time_changed",
        "appointment",
        "appointment",
        username,
        {
          fromTime: oldTimeFormatted,
          toTime: "Cleared",
          fromConsultStart: oldConsultFormatted,
          toConsultStart: "Cleared",
          description: "Check-in time cleared (Waiting List appointment)",
        },
      );

      return {
        success: true,
        message: "Check-in time cleared successfully.",
        newConsultStart: null,
      };
    }

    // Normalize and validate the time slot
    try {
      normalizedTimeSlot = normalizeTimeSlot(timeString);
    } catch (normalizationError) {
      return {
        success: false,
        message: "Failed to normalize time: " + normalizationError.message,
      };
    }

    // Validate the normalized time format
    const validationData = {
      appointmentDate: normalizeAppointmentDate(appointmentDate),
      timeSlot: normalizedTimeSlot,
      appointmentType: "REGULAR", // Assume regular since we have a time slot
    };

    const validation = validateAppointmentData(validationData);
    if (!validation.valid) {
      return {
        success: false,
        message: "Validation failed: " + validation.errors.join("; "),
      };
    }

    // Update TimeSlot with normalized HH:MM string
    appointmentSheet
      .getRange(rowIndex + 1, timeSlotCol + 1)
      .setValue(normalizedTimeSlot);

    // Calculate new Consult Start (if needed)
    // Note: calculateConsultStartForSingleAppointment may need to be updated to work with HH:MM strings
    // For now, we'll create a Date object for the calculation, then store the result as HH:MM
    if (consultStartCol !== -1 && planOfAction) {
      // Create a temporary Date object for calculation purposes
      const timeParts = normalizedTimeSlot.split(":");
      const hours = parseInt(timeParts[0], 10);
      const minutes = parseInt(timeParts[1], 10);
      const appointmentDateObj = new Date(appointmentDate);
      const tempTimeSlotDate = new Date(
        appointmentDateObj.getFullYear(),
        appointmentDateObj.getMonth(),
        appointmentDateObj.getDate(),
        hours,
        minutes,
        0,
      );

      const consultStartDate = calculateConsultStartForSingleAppointment(
        appointmentId,
        tempTimeSlotDate,
        planOfAction,
      );
      if (consultStartDate) {
        // Store Consult Start as HH:MM string
        const consultHours = consultStartDate.getHours();
        const consultMinutes = consultStartDate.getMinutes();
        newConsultStart =
          ("0" + consultHours).slice(-2) +
          ":" +
          ("0" + consultMinutes).slice(-2);
        appointmentSheet
          .getRange(rowIndex + 1, consultStartCol + 1)
          .setValue(newConsultStart);
      } else {
        // If calculation fails, clear Consult Start
        appointmentSheet
          .getRange(rowIndex + 1, consultStartCol + 1)
          .setValue("");
      }
    }

    // Format times for journey logging
    const oldTimeFormatted = oldTimeSlot
      ? typeof oldTimeSlot === "string"
        ? oldTimeSlot
        : Utilities.formatDate(
            new Date(oldTimeSlot),
            Session.getScriptTimeZone(),
            "HH:mm",
          )
      : "N/A";
    const newTimeFormatted = normalizedTimeSlot;
    const oldConsultFormatted = oldConsultStart
      ? typeof oldConsultStart === "string"
        ? oldConsultStart
        : Utilities.formatDate(
            new Date(oldConsultStart),
            Session.getScriptTimeZone(),
            "HH:mm",
          )
      : "N/A";
    const newConsultFormatted = newConsultStart || "N/A";

    // Log journey entry
    logAppointmentJourney(
      appointmentId,
      "checkin_time_changed",
      "appointment",
      "appointment",
      username,
      {
        fromTime: oldTimeFormatted,
        toTime: newTimeFormatted,
        fromConsultStart: oldConsultFormatted,
        toConsultStart: newConsultFormatted,
        description:
          "Check-in time updated from " +
          oldTimeFormatted +
          " to " +
          newTimeFormatted +
          (newConsultStart
            ? " (Consult Start: " + newConsultFormatted + ")"
            : ""),
      },
    );

    return {
      success: true,
      message: "Check-in time updated successfully.",
      newConsultStart: newConsultFormatted,
    };
  } catch (e) {
    return {
      success: false,
      message: "Error updating check-in time: " + e.toString(),
    };
  }
}

/**
 * Calculate Consult Start for a single appointment
 * @param {string} appointmentId - The appointment ID
 * @param {Date} timeSlot - The TimeSlot Date object
 * @param {string} planOfAction - The PlanOfAction string
 * @return {Date|null} Calculated Consult Start Date or null on error
 */
function calculateConsultStartForSingleAppointment(
  appointmentId,
  timeSlot,
  planOfAction,
) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const planOfActionSheet = ss.getSheetByName("PlanOfActionMaster");

    if (!planOfActionSheet) {
      return null;
    }

    // Load PlanOfActionMaster data
    const planData = planOfActionSheet.getDataRange().getValues();
    const planHeaders = planData[0];
    const procedureMap = new Map();

    const procCol = planHeaders.indexOf("Plan of action");
    const prepCol = planHeaders.indexOf("PrepMin");

    if (procCol === -1 || prepCol === -1) {
      return null;
    }

    // Build procedure map with prep times
    for (let i = 1; i < planData.length; i++) {
      const procedure = planData[i][procCol];
      if (procedure) {
        procedureMap.set(procedure.toString().trim().toUpperCase(), {
          prep: parseInt(planData[i][prepCol], 10) || 0,
        });
      }
    }

    // Calculate max prep time from procedures
    let maxPrepTime = 0;

    try {
      let procedures = [];
      if (typeof planOfAction === "string" && planOfAction.startsWith("[")) {
        procedures = JSON.parse(planOfAction);
      } else if (planOfAction) {
        procedures = planOfAction
          .toString()
          .split(/[/,;]/)
          .map((p) => p.trim());
      }

      procedures.forEach((proc) => {
        let procName = typeof proc === "object" ? proc.name : proc.toString();
        procName = procName
          .replace(/\s*\([^)]*\)\s*/, "")
          .trim()
          .toUpperCase();

        const procData = procedureMap.get(procName);
        if (procData) {
          maxPrepTime = Math.max(maxPrepTime, procData.prep);
        }
      });
    } catch (e) {}

    // Calculate Consult Start = TimeSlot + maxPrepTime
    const consultStartDate = new Date(timeSlot.getTime() + maxPrepTime * 60000);

    return consultStartDate;
  } catch (e) {
    return null;
  }
}

function rescheduleAppointment(data) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("appointment");
    const dataRange = sheet.getDataRange();
    const values = dataRange.getValues();
    const headers = values[0];

    // Get username from session token
    const username = getSessionUsername(data.sessionToken);
    if (!username) {
      return {
        success: false,
        message: "Invalid session. Please login again.",
      };
    }

    // Validate and normalize date/time data before processing
    // Skip time validation for WAITING LIST appointments
    const validationData = {
      appointmentDate: data.newDate,
      timeSlot: data.newTimeSlot,
      appointmentType: data.appointmentType,
    };

    const validation = validateAppointmentData(validationData);
    if (!validation.valid) {
      return {
        success: false,
        message: "Validation failed: " + validation.errors.join("; "),
      };
    }

    // Normalize date and time formats
    try {
      data.newDate = normalizeAppointmentDate(data.newDate);

      // Only normalize time slot if not WAITING LIST
      if (data.appointmentType !== "WAITING LIST" && data.newTimeSlot) {
        data.newTimeSlot = normalizeTimeSlot(data.newTimeSlot);
      }
    } catch (normalizationError) {
      return {
        success: false,
        message: "Data format error: " + normalizationError.message,
      };
    }

    // Find the appointment row
    const rowIndex = values.findIndex((row) => row[0] === data.appointmentId);
    if (rowIndex === -1)
      return { success: false, message: "Appointment not found" };

    // Get the current appointment date (to update planningB stats for old date later)
    const oldDate = values[rowIndex][headers.indexOf("AppointmentDate")];
    let oldDateStr = "";
    if (oldDate instanceof Date) {
      oldDateStr = Utilities.formatDate(
        oldDate,
        Session.getScriptTimeZone(),
        "yyyy-MM-dd",
      );
    } else if (oldDate) {
      oldDateStr = oldDate.toString().trim();
    }

    // Check slot availability for new date (skip for WAITING LIST)
    if (data.appointmentType !== "WAITING LIST" && data.newTimeSlot) {
      const slotAvailability = checkSlotAvailability(data.newDate);
      if (!slotAvailability.available) {
        return {
          success: false,
          message:
            slotAvailability.message ||
            "No slots available for the selected date. MaxSlots may not be set or all slots are booked.",
        };
      }
    }

    // Update core appointment details (excluding Remarks and Tags - handled separately)
    // Note: Tags in column AF (index 31) are intentionally NOT modified during reschedule
    // to ensure they persist with the rescheduled appointment (Requirement 5.3)
    const updateMap = {
      AppointmentDate: data.newDate,
      TimeSlot: data.newTimeSlot,
      AppointmentType: data.appointmentType,
      Doctor: data.doctor,
      PlanOfAction: data.newPlanOfAction,
    };

    // Update spreadsheet columns
    Object.entries(updateMap).forEach(([header, value]) => {
      const colIndex = headers.indexOf(header);
      if (colIndex !== -1) {
        sheet.getRange(rowIndex + 1, colIndex + 1).setValue(value);
      }
    });

    // Log tag preservation for audit trail
    const TAG_COLUMN_INDEX = 31;
    const existingTags = values[rowIndex][TAG_COLUMN_INDEX] || "";
    if (existingTags && existingTags.trim() !== "") {
    }

    // Add new remark to history if provided
    if (data.newRemarks && data.newRemarks.trim() !== "") {
      addRemarkToHistory(
        data.appointmentId,
        data.newRemarks.trim(),
        data.sessionToken,
      );
    }

    // Clear confirmation columns as fresh confirmations will be required
    const fourDayConfirmDateCol = headers.indexOf("FourDayConfirmDate");
    const fourDayConfirmByCol = headers.indexOf("FourDayConfirmBy");
    const oneDayConfirmDateCol = headers.indexOf("OneDayConfirmDate");
    const oneDayConfirmByCol = headers.indexOf("OneDayConfirmBy");
    const consultStartCol = headers.indexOf("Consult Start");

    if (fourDayConfirmDateCol !== -1) {
      sheet.getRange(rowIndex + 1, fourDayConfirmDateCol + 1).setValue("");
    }
    if (fourDayConfirmByCol !== -1) {
      sheet.getRange(rowIndex + 1, fourDayConfirmByCol + 1).setValue("");
    }
    if (oneDayConfirmDateCol !== -1) {
      sheet.getRange(rowIndex + 1, oneDayConfirmDateCol + 1).setValue("");
    }
    if (oneDayConfirmByCol !== -1) {
      sheet.getRange(rowIndex + 1, oneDayConfirmByCol + 1).setValue("");
    }
    if (consultStartCol !== -1) {
      sheet.getRange(rowIndex + 1, consultStartCol + 1).setValue("");
    }

    // Update reschedule history (using username instead of email)
    const historyCol = headers.indexOf("RescheduleHistory");
    const history = values[rowIndex][historyCol]
      ? JSON.parse(values[rowIndex][historyCol])
      : [];

    // Get the current appointment date and time before updating
    const currentDate = values[rowIndex][headers.indexOf("AppointmentDate")];
    const currentTime = values[rowIndex][headers.indexOf("TimeSlot")];

    history.push({
      timestamp: new Date(),
      by: username, // Use username from Login sheet instead of email
      fromDate: currentDate,
      toDate: data.newDate,
      fromTime: currentTime,
      toTime: data.newTimeSlot,
      action: "rescheduled",
    });
    sheet
      .getRange(rowIndex + 1, historyCol + 1)
      .setValue(JSON.stringify(history));

    // Update tracking columns (using username instead of email)
    const rescheduleDateCol = headers.indexOf("RescheduledDate");
    const rescheduledByCol = headers.indexOf("RescheduledBy");
    const now = new Date();
    sheet.getRange(rowIndex + 1, rescheduleDateCol + 1).setValue(now);
    sheet.getRange(rowIndex + 1, rescheduledByCol + 1).setValue(username); // Use username from Login sheet instead of email

    // Auto-calculate Consult Start when applicable (skip waiting list or missing time slot)
    const shouldCalculateConsultStart =
      data.newTimeSlot &&
      data.newTimeSlot !== "" &&
      (!data.appointmentType ||
        data.appointmentType.toString().toUpperCase() !== "WAITING LIST");
    if (shouldCalculateConsultStart) {
      try {
        const consultStartResult = calculateConsultStartForAppointments();
        if (!consultStartResult || !consultStartResult.success) {
        }
      } catch (consultError) {}
    }

    // ✅ ETERNAL TRACKING: Log reschedule journey entry
    // Format dates and times consistently
    const fromDateFormatted = Utilities.formatDate(
      new Date(currentDate),
      Session.getScriptTimeZone(),
      "yyyy-MM-dd",
    );
    const fromTimeFormatted =
      typeof currentTime === "object" && currentTime instanceof Date
        ? Utilities.formatDate(
            currentTime,
            Session.getScriptTimeZone(),
            "HH:mm",
          )
        : currentTime || "";

    logAppointmentJourney(
      data.appointmentId,
      "rescheduled",
      "appointment",
      "appointment",
      username,
      {
        fromDate: fromDateFormatted,
        toDate: data.newDate,
        fromTime: fromTimeFormatted,
        toTime: data.newTimeSlot,
        description: "Appointment rescheduled",
      },
    );

    // Update planningA sheet to mark new slot as booked (and free old slot)
    try {
      updatePlanningASheet();
    } catch (planningError) {}

    // Update planningB stats for the new date
    try {
      updatePlanningBStats(data.newDate);
    } catch (planningBError) {}

    // Update planningB stats for the old date (to free up the slot count)
    if (oldDateStr && oldDateStr !== data.newDate) {
      try {
        updatePlanningBStats(oldDateStr);
      } catch (planningBOldError) {}
    }

    // Log audit event for appointment reschedule
    try {
      logAuditEvent(
        data.sessionToken,
        "RESCHEDULE_APPOINTMENT",
        "APPOINTMENT",
        data.appointmentId,
        {
          before: {
            date: fromDateFormatted,
            time: fromTimeFormatted,
          },
          after: {
            date: data.newDate,
            time: data.newTimeSlot,
          },
          mrdNo: values[rowIndex][3], // MRDNo - Column D
          patientName: values[rowIndex][4], // Name - Column E
          doctor: data.doctor,
          sheetName: "appointment",
        },
      );
    } catch (auditError) {
      // Don't fail reschedule if audit logging fails
      Logger.log(
        "Audit logging failed for appointment reschedule: " +
          auditError.toString(),
      );
    }

    // Keep any advance payment attached to this appointment in step with its
    // new date and time (handoff §29). The payment itself is NOT touched —
    // rescheduling never refunds. Guarded so a payment-module problem can
    // never turn a successful reschedule into a reported failure.
    try {
      if (typeof syncPaymentAfterReschedule === "function") {
        syncPaymentAfterReschedule(
          data.appointmentId,
          data.sessionToken,
          { fromDate: fromDateFormatted, fromTime: fromTimeFormatted },
        );
      }
    } catch (paymentSyncError) {
      Logger.log(
        "Payment record sync after reschedule failed for " +
          data.appointmentId +
          ": " +
          paymentSyncError.toString(),
      );
    }

    return { success: true, message: "Appointment rescheduled successfully" };
  } catch (e) {
    console.error("Reschedule error:", e);
    return {
      success: false,
      message: "Error rescheduling appointment: " + e.toString(),
    };
  }
}
// Function to generate new MRD number
function generateNewMRD() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("appointment");
    if (!sheet) {
      throw new Error("appointment sheet not found.");
    }

    // Get all MRD numbers from column D
    var data = sheet.getDataRange().getValues();
    var maxMRD = 0;

    // Start from row 2 to skip header
    for (var i = 1; i < data.length; i++) {
      var mrd = data[i][3].toString().trim();
      if (mrd.startsWith("N")) {
        // Extract the number part after 'N'
        var num = parseInt(mrd.substring(1));
        if (!isNaN(num) && num > maxMRD) {
          maxMRD = num;
        }
      }
    }

    // Generate new MRD number by incrementing the max number found
    var newMRD = "N" + (maxMRD + 1).toString().padStart(4, "0");
    return newMRD;
  } catch (e) {
    throw e;
  }
}

// Dashboard Statistics Functions
function getTodayAppointmentsCount() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const appointmentsSheet = ss.getSheetByName("appointment");
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const data = appointmentsSheet.getDataRange().getValues();
  let count = 0;
  let yesterdayCount = 0;
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  for (let i = 1; i < data.length; i++) {
    const appointmentDate = new Date(data[i][1]); // Column B is appointment date
    appointmentDate.setHours(0, 0, 0, 0);

    if (appointmentDate.getTime() === today.getTime()) {
      count++;
    } else if (appointmentDate.getTime() === yesterday.getTime()) {
      yesterdayCount++;
    }
  }

  return {
    count: count,
    trend:
      yesterdayCount > 0
        ? (((count - yesterdayCount) / yesterdayCount) * 100).toFixed(1)
        : 0,
  };
}

function getTodayAppointmentTypeBreakdown() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentsSheet = ss.getSheetByName("appointment");

    if (!appointmentsSheet) {
      return { types: {}, total: 0 };
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const data = appointmentsSheet.getDataRange().getValues();
    const headers = data[0];

    // Get column indices
    const dateCol = headers.indexOf("AppointmentDate");
    const typeCol = headers.indexOf("AppointmentType");

    // Fallback to default indices if headers not found
    const dateIndex = dateCol !== -1 ? dateCol : 1; // Column B
    const typeIndex = typeCol !== -1 ? typeCol : 8; // Column I

    const typeCounts = {};
    let total = 0;

    for (let i = 1; i < data.length; i++) {
      const appointmentDate = new Date(data[i][dateIndex]);
      appointmentDate.setHours(0, 0, 0, 0);

      if (appointmentDate.getTime() === today.getTime()) {
        const appointmentType = data[i][typeIndex];
        const typeName =
          appointmentType && appointmentType.toString().trim() !== ""
            ? appointmentType.toString().trim()
            : "Not Specified";

        typeCounts[typeName] = (typeCounts[typeName] || 0) + 1;
        total++;
      }
    }

    return {
      types: typeCounts,
      total: total,
    };
  } catch (error) {
    Logger.log(
      "Error in getTodayAppointmentTypeBreakdown: " + error.toString(),
    );
    return { types: {}, total: 0 };
  }
}

/**
 * Determines the next day with appointments (tomorrow or day after tomorrow)
 * @return {string} Date string in YYYY-MM-DD format
 */
function getNextDayWithAppointments() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentsSheet = ss.getSheetByName("appointment");

    if (!appointmentsSheet) {
      // If no sheet, return tomorrow's date
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      return Utilities.formatDate(
        tomorrow,
        Session.getScriptTimeZone(),
        "yyyy-MM-dd",
      );
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const data = appointmentsSheet.getDataRange().getValues();
    const headers = data[0];
    const dateCol = headers.indexOf("AppointmentDate");
    const dateIndex = dateCol !== -1 ? dateCol : 1; // Column B

    // Check tomorrow
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const tomorrowStr = Utilities.formatDate(
      tomorrow,
      Session.getScriptTimeZone(),
      "yyyy-MM-dd",
    );

    let tomorrowCount = 0;
    for (let i = 1; i < data.length; i++) {
      const appointmentDate = new Date(data[i][dateIndex]);
      appointmentDate.setHours(0, 0, 0, 0);
      if (appointmentDate.getTime() === tomorrow.getTime()) {
        tomorrowCount++;
      }
    }

    // If tomorrow has appointments, return tomorrow
    if (tomorrowCount > 0) {
      return tomorrowStr;
    }

    // Otherwise, return day after tomorrow
    const dayAfterTomorrow = new Date(today);
    dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 2);
    return Utilities.formatDate(
      dayAfterTomorrow,
      Session.getScriptTimeZone(),
      "yyyy-MM-dd",
    );
  } catch (error) {
    Logger.log("Error in getNextDayWithAppointments: " + error.toString());
    // Fallback to tomorrow
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return Utilities.formatDate(
      tomorrow,
      Session.getScriptTimeZone(),
      "yyyy-MM-dd",
    );
  }
}

/**
 * Gets appointment count for the next day (tomorrow or day after tomorrow)
 * @return {Object} { count: number, date: string, label: string }
 */
function getNextDayAppointmentsCount() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentsSheet = ss.getSheetByName("appointment");

    if (!appointmentsSheet) {
      return { count: 0, date: "", label: "Tomorrow" };
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const nextDayDateStr = getNextDayWithAppointments();
    const nextDayDate = new Date(nextDayDateStr);
    nextDayDate.setHours(0, 0, 0, 0);

    // Determine label
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const isTomorrow = nextDayDate.getTime() === tomorrow.getTime();
    const label = isTomorrow ? "Tomorrow" : "Day After Tomorrow";

    const data = appointmentsSheet.getDataRange().getValues();
    const headers = data[0];
    const dateCol = headers.indexOf("AppointmentDate");
    const dateIndex = dateCol !== -1 ? dateCol : 1; // Column B

    let count = 0;
    for (let i = 1; i < data.length; i++) {
      const appointmentDate = new Date(data[i][dateIndex]);
      appointmentDate.setHours(0, 0, 0, 0);
      if (appointmentDate.getTime() === nextDayDate.getTime()) {
        count++;
      }
    }

    return {
      count: count,
      date: nextDayDateStr,
      label: label,
    };
  } catch (error) {
    Logger.log("Error in getNextDayAppointmentsCount: " + error.toString());
    return { count: 0, date: "", label: "Tomorrow" };
  }
}

/**
 * Gets appointment type breakdown for the next day (tomorrow or day after tomorrow)
 * @return {Object} { types: object, total: number, date: string, label: string }
 */
function getNextDayAppointmentTypeBreakdown() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentsSheet = ss.getSheetByName("appointment");

    if (!appointmentsSheet) {
      return { types: {}, total: 0, date: "", label: "Tomorrow" };
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const nextDayDateStr = getNextDayWithAppointments();
    const nextDayDate = new Date(nextDayDateStr);
    nextDayDate.setHours(0, 0, 0, 0);

    // Determine label
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const isTomorrow = nextDayDate.getTime() === tomorrow.getTime();
    const label = isTomorrow ? "Tomorrow" : "Day After Tomorrow";

    const data = appointmentsSheet.getDataRange().getValues();
    const headers = data[0];

    // Get column indices
    const dateCol = headers.indexOf("AppointmentDate");
    const typeCol = headers.indexOf("AppointmentType");

    // Fallback to default indices if headers not found
    const dateIndex = dateCol !== -1 ? dateCol : 1; // Column B
    const typeIndex = typeCol !== -1 ? typeCol : 8; // Column I

    const typeCounts = {};
    let total = 0;

    for (let i = 1; i < data.length; i++) {
      const appointmentDate = new Date(data[i][dateIndex]);
      appointmentDate.setHours(0, 0, 0, 0);

      if (appointmentDate.getTime() === nextDayDate.getTime()) {
        const appointmentType = data[i][typeIndex];
        const typeName =
          appointmentType && appointmentType.toString().trim() !== ""
            ? appointmentType.toString().trim()
            : "Not Specified";

        typeCounts[typeName] = (typeCounts[typeName] || 0) + 1;
        total++;
      }
    }

    return {
      types: typeCounts,
      total: total,
      date: nextDayDateStr,
      label: label,
    };
  } catch (error) {
    Logger.log(
      "Error in getNextDayAppointmentTypeBreakdown: " + error.toString(),
    );
    return { types: {}, total: 0, date: "", label: "Tomorrow" };
  }
}

/**
 * Gets slot status for the next day (tomorrow or day after tomorrow)
 * @return {Object} { maxSlots, naa, oaa, taa, raa, date: string, label: string }
 */
function getNextDaySlotStatus() {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const nextDayDateStr = getNextDayWithAppointments();
    const nextDayDate = new Date(nextDayDateStr);
    nextDayDate.setHours(0, 0, 0, 0);

    // Determine label
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const isTomorrow = nextDayDate.getTime() === tomorrow.getTime();
    const label = isTomorrow ? "Tomorrow" : "Day After Tomorrow";

    // Get slot status for the date
    const slotStatus = getSlotStatusForDate(nextDayDateStr);

    return {
      maxSlots: slotStatus.maxSlots || 0,
      naa: slotStatus.naa || 0,
      oaa: slotStatus.oaa || 0,
      taa: slotStatus.taa || 0,
      raa: slotStatus.raa || 0,
      date: nextDayDateStr,
      label: label,
    };
  } catch (error) {
    Logger.log("Error in getNextDaySlotStatus: " + error.toString());
    return {
      maxSlots: 0,
      naa: 0,
      oaa: 0,
      taa: 0,
      raa: 0,
      date: "",
      label: "Tomorrow",
    };
  }
}

function getPending4DayConfirmationsCount() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("appointment");
  const data = sheet.getDataRange().getValues();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 1. Build next 4 working days (skip Sundays)
  const workDays = [];
  let cursor = new Date(today);
  while (workDays.length < 4) {
    if (cursor.getDay() !== 0) workDays.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  // 2. Filter and count
  let pendingCount = 0;
  let totalCount = 0;
  let minDistance = Infinity;

  data.slice(1).forEach((row) => {
    const apptDate = new Date(row[1]);
    apptDate.setHours(0, 0, 0, 0);
    const fourDayConfirm = row[14]; // FourDayConfirmDate

    // Is this date in our 4-day window?
    const idx = workDays.findIndex((d) => d.getTime() === apptDate.getTime());
    if (idx > -1) {
      totalCount++;
      if (!fourDayConfirm) {
        pendingCount++;
        minDistance = Math.min(minDistance, idx);
      }
    }
  });

  // 3. Trend %
  const trend = totalCount ? (pendingCount / totalCount) * 100 : 0;

  // 4. Urgency
  let urgency = "success";
  if (minDistance <= 2) urgency = "danger";
  else if (minDistance <= 3) urgency = "warning";

  return { count: pendingCount, trend, urgency };
}

function getPendingConfirmationBreakdown() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentsSheet = ss.getSheetByName("appointment");

    if (!appointmentsSheet) {
      return { days: [] };
    }

    const data = appointmentsSheet.getDataRange().getValues();
    const headers = data[0];

    // Get column indices
    const dateCol = headers.indexOf("AppointmentDate");
    const fourDayConfirmCol = headers.indexOf("FourDayConfirmDate");
    const oneDayConfirmCol = headers.indexOf("OneDayConfirmDate");

    // Fallback indices
    const dateIndex = dateCol !== -1 ? dateCol : 1; // Column B
    const fourDayIndex = fourDayConfirmCol !== -1 ? fourDayConfirmCol : 14; // Column O
    const oneDayIndex = oneDayConfirmCol !== -1 ? oneDayConfirmCol : 16; // Column Q

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Start from tomorrow
    let currentDate = new Date(today);
    currentDate.setDate(currentDate.getDate() + 1);

    const result = [];
    const dayNames = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];

    // Find next 4 days with appointments (skip Sundays and days with no appointments)
    while (result.length < 4) {
      // Skip Sundays
      if (currentDate.getDay() === 0) {
        currentDate.setDate(currentDate.getDate() + 1);
        continue;
      }

      // Check if this day has appointments
      let fourDayPending = 0;
      let oneDayPending = 0;
      let hasAppointments = false;

      for (let i = 1; i < data.length; i++) {
        const appointmentDate = new Date(data[i][dateIndex]);
        appointmentDate.setHours(0, 0, 0, 0);

        if (appointmentDate.getTime() === currentDate.getTime()) {
          hasAppointments = true;
          const fourDayConfirm = data[i][fourDayIndex];
          const oneDayConfirm = data[i][oneDayIndex];

          if (!fourDayConfirm || fourDayConfirm.toString().trim() === "") {
            fourDayPending++;
          }
          if (!oneDayConfirm || oneDayConfirm.toString().trim() === "") {
            oneDayPending++;
          }
        }
      }

      // Only add this day if it has appointments
      if (hasAppointments) {
        result.push({
          date: Utilities.formatDate(
            currentDate,
            Session.getScriptTimeZone(),
            "yyyy-MM-dd",
          ),
          dayName: dayNames[currentDate.getDay()],
          fourDayPending: fourDayPending,
          oneDayPending: oneDayPending,
        });
      }

      currentDate.setDate(currentDate.getDate() + 1);

      // Safety check: don't loop forever
      if (currentDate > new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000)) {
        break; // Stop after checking 60 days ahead
      }
    }

    return { days: result };
  } catch (error) {
    Logger.log("Error in getPendingConfirmationBreakdown: " + error.toString());
    return { days: [] };
  }
}

function getMonthlyPatientsCount() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const appointmentsSheet = ss.getSheetByName("appointment");
  const today = new Date();
  const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const firstDayOfLastMonth = new Date(
    today.getFullYear(),
    today.getMonth() - 1,
    1,
  );

  const data = appointmentsSheet.getDataRange().getValues();
  let currentMonthCount = 0;
  let lastMonthCount = 0;
  const uniquePatients = new Set();
  const lastMonthPatients = new Set();

  for (let i = 1; i < data.length; i++) {
    const appointmentDate = new Date(data[i][1]); // Column B is appointment date
    const patientMRD = data[i][3]; // Column D is MRD No

    if (appointmentDate >= firstDayOfMonth) {
      uniquePatients.add(patientMRD);
      currentMonthCount = uniquePatients.size;
    } else if (
      appointmentDate >= firstDayOfLastMonth &&
      appointmentDate < firstDayOfMonth
    ) {
      lastMonthPatients.add(patientMRD);
      lastMonthCount = lastMonthPatients.size;
    }
  }

  return {
    count: currentMonthCount,
    trend:
      lastMonthCount > 0
        ? (
            ((currentMonthCount - lastMonthCount) / lastMonthCount) *
            100
          ).toFixed(1)
        : 0,
  };
}

function getMonthlyPatientsBreakdown() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const today = new Date();
    const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    // 1. Waiting List Count (from appointment sheet - current month only)
    let waitingListCount = 0;
    const appointmentsSheet = ss.getSheetByName("appointment");
    if (appointmentsSheet) {
      const data = appointmentsSheet.getDataRange().getValues();
      const headers = data[0];

      const dateCol = headers.indexOf("AppointmentDate");
      const typeCol = headers.indexOf("AppointmentType");
      const mrdCol = headers.indexOf("MRDNo");

      const dateIndex = dateCol !== -1 ? dateCol : 1; // Column B
      const typeIndex = typeCol !== -1 ? typeCol : 8; // Column I
      const mrdIndex = mrdCol !== -1 ? mrdCol : 3; // Column D

      const waitingListMRDs = new Set();
      for (let i = 1; i < data.length; i++) {
        const appointmentDate = new Date(data[i][dateIndex]);
        const appointmentType = data[i][typeIndex];
        const mrd = data[i][mrdIndex];

        if (
          appointmentDate >= firstDayOfMonth &&
          appointmentDate.getFullYear() === today.getFullYear() &&
          appointmentDate.getMonth() === today.getMonth() &&
          appointmentType &&
          appointmentType.toString().trim().toUpperCase() === "WAITING LIST" &&
          mrd &&
          mrd.toString().trim() !== ""
        ) {
          waitingListMRDs.add(mrd.toString().trim().toUpperCase());
        }
      }
      waitingListCount = waitingListMRDs.size;
    }

    // 2. Direct Call Count (all records)
    let directCallCount = 0;
    const directCallSheet = ss.getSheetByName("directCall");
    if (directCallSheet) {
      const data = directCallSheet.getDataRange().getValues();
      const headers = data[0];

      const mrdCol = headers.indexOf("MRDNo");
      const mrdIndex = mrdCol !== -1 ? mrdCol : 1; // Column B

      const directCallMRDs = new Set();
      for (let i = 1; i < data.length; i++) {
        const mrd = data[i][mrdIndex];
        if (mrd && mrd.toString().trim() !== "") {
          directCallMRDs.add(mrd.toString().trim().toUpperCase());
        }
      }
      directCallCount = directCallMRDs.size;
    }

    // 3. Followup Count (current month only)
    let followupCount = 0;
    const followupSheet = ss.getSheetByName("followup");
    if (followupSheet) {
      const data = followupSheet.getDataRange().getValues();
      const headers = data[0];

      const followupDateCol = headers.indexOf("follow_up_date");
      const mrdCol = headers.indexOf("MRDNo");

      const followupDateIndex = followupDateCol !== -1 ? followupDateCol : 4; // Column E
      const mrdIndex = mrdCol !== -1 ? mrdCol : 14; // Column O (index 14)

      const followupMRDs = new Set();
      for (let i = 1; i < data.length; i++) {
        const followupDate = new Date(data[i][followupDateIndex]);
        const mrd = data[i][mrdIndex];

        if (
          followupDate >= firstDayOfMonth &&
          followupDate.getFullYear() === today.getFullYear() &&
          followupDate.getMonth() === today.getMonth() &&
          mrd &&
          mrd.toString().trim() !== ""
        ) {
          followupMRDs.add(mrd.toString().trim().toUpperCase());
        }
      }
      followupCount = followupMRDs.size;
    }

    // 4. Cancelled Count (all records)
    let cancelledCount = 0;
    const cancelSheet = ss.getSheetByName("cancel");
    if (cancelSheet) {
      const data = cancelSheet.getDataRange().getValues();
      const headers = data[0];

      const mrdCol = headers.indexOf("MRDNo");
      const mrdIndex = mrdCol !== -1 ? mrdCol : 3; // Column D

      const cancelledMRDs = new Set();
      for (let i = 1; i < data.length; i++) {
        const mrd = data[i][mrdIndex];
        if (mrd && mrd.toString().trim() !== "") {
          cancelledMRDs.add(mrd.toString().trim().toUpperCase());
        }
      }
      cancelledCount = cancelledMRDs.size;
    }

    return {
      waitingList: waitingListCount,
      directCall: directCallCount,
      followup: followupCount,
      cancelled: cancelledCount,
    };
  } catch (error) {
    Logger.log("Error in getMonthlyPatientsBreakdown: " + error.toString());
    return {
      waitingList: 0,
      directCall: 0,
      followup: 0,
      cancelled: 0,
    };
  }
}

function getUpcomingAppointments() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentsSheet = ss.getSheetByName("appointment");

    if (!appointmentsSheet) {
      return {
        success: false,
        message: "Appointment sheet not found",
        appointments: [],
      };
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const data = appointmentsSheet.getDataRange().getValues();

    const headers = data[0];
    const upcomingAppointments = [];

    // Get column indices
    const idCol = headers.indexOf("AppointmentID");
    const dateCol = headers.indexOf("AppointmentDate");
    const timeCol = headers.indexOf("TimeSlot");
    const patientNameCol = headers.indexOf("PatientName");
    const typeCol = headers.indexOf("AppointmentType");
    const doctorCol = headers.indexOf("Doctor");
    const fourDayConfirmDateCol = headers.indexOf("FourDayConfirmDate");
    const fourDayConfirmByCol = headers.indexOf("FourDayConfirmBy");
    const oneDayConfirmDateCol = headers.indexOf("OneDayConfirmDate");
    const oneDayConfirmByCol = headers.indexOf("OneDayConfirmBy");
    const mrdCol = headers.indexOf("MRDNo");
    const phoneCol = headers.indexOf("Phone");

    // Validate column indices
    if (
      idCol === -1 ||
      dateCol === -1 ||
      timeCol === -1 ||
      patientNameCol === -1 ||
      typeCol === -1 ||
      doctorCol === -1 ||
      fourDayConfirmDateCol === -1 ||
      fourDayConfirmByCol === -1 ||
      oneDayConfirmDateCol === -1 ||
      oneDayConfirmByCol === -1
    ) {
      return {
        success: false,
        message: "Required columns not found in sheet",
        appointments: [],
      };
    }

    for (let i = 1; i < data.length; i++) {
      try {
        const row = data[i];
        if (!row[idCol] || !row[dateCol] || !row[timeCol]) {
          continue;
        }

        const appointmentDate = new Date(row[dateCol]);
        const fourDayConfirmed = row[fourDayConfirmDateCol];
        const oneDayConfirmed = row[oneDayConfirmDateCol];

        // Skip if both confirmations are done
        if (fourDayConfirmed && oneDayConfirmed) {
          continue;
        }

        if (appointmentDate >= today) {
          // Format dates as strings for serialization
          let appointmentTime;
          try {
            appointmentTime = Utilities.formatDate(
              new Date(row[timeCol]),
              Session.getScriptTimeZone(),
              "HH:mm",
            );
          } catch (timeError) {
            appointmentTime = "00:00"; // Default time if there's an error
          }

          let formattedFourDayDate = null;
          if (fourDayConfirmed) {
            try {
              formattedFourDayDate = Utilities.formatDate(
                new Date(fourDayConfirmed),
                Session.getScriptTimeZone(),
                "yyyy-MM-dd",
              );
            } catch (dateError) {}
          }

          let formattedOneDayDate = null;
          if (oneDayConfirmed) {
            try {
              formattedOneDayDate = Utilities.formatDate(
                new Date(oneDayConfirmed),
                Session.getScriptTimeZone(),
                "yyyy-MM-dd",
              );
            } catch (dateError) {}
          }

          const appointment = {
            id: row[idCol].toString(),
            time: appointmentTime,
            date: Utilities.formatDate(
              appointmentDate,
              Session.getScriptTimeZone(),
              "yyyy-MM-dd",
            ),
            patientName: row[patientNameCol]
              ? row[patientNameCol].toString()
              : "",
            mrdNo: row[mrdCol] ? row[mrdCol].toString() : "",
            phone: row[phoneCol] ? row[phoneCol].toString() : "",
            type: row[typeCol] ? row[typeCol].toString() : "",
            doctor: row[doctorCol] ? row[doctorCol].toString() : "",
            fourDayConfirmDate: formattedFourDayDate,
            fourDayConfirmBy: row[fourDayConfirmByCol]
              ? row[fourDayConfirmByCol].toString()
              : "",
            oneDayConfirmDate: formattedOneDayDate,
            oneDayConfirmBy: row[oneDayConfirmByCol]
              ? row[oneDayConfirmByCol].toString()
              : "",
          };

          // Validate appointment data
          if (!appointment.id || !appointment.time) {
            continue;
          }

          upcomingAppointments.push(appointment);
        }
      } catch (rowError) {}
    }

    // Sort by date first, then by time
    upcomingAppointments.sort((a, b) => {
      // First compare dates
      const dateA = new Date(a.date);
      const dateB = new Date(b.date);
      const dateDiff = dateA - dateB;

      // If dates are the same, compare times
      if (dateDiff === 0) {
        const timeA = a.time.split(":");
        const timeB = b.time.split(":");
        const hourDiff = parseInt(timeA[0]) - parseInt(timeB[0]);
        if (hourDiff !== 0) return hourDiff;
        return parseInt(timeA[1]) - parseInt(timeB[1]);
      }

      return dateDiff;
    });

    // Return only next 5 appointments
    const result = upcomingAppointments.slice(0, 5);

    // Create response object
    const response = {
      success: true,
      appointments: result,
      timestamp: new Date().getTime(),
    };

    // Serialize and deserialize to ensure JSON compatibility
    const jsonString = JSON.stringify(response);

    // Return parsed object
    return JSON.parse(jsonString);
  } catch (error) {
    // Return a simple error object that is guaranteed to be serializable
    return {
      success: false,
      message: "Error: " + error.toString(),
      appointments: [],
      timestamp: new Date().getTime(),
    };
  }
}

function getAppointmentDistribution() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const appointmentsSheet = ss.getSheetByName("appointment");
  const today = new Date();
  const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  const data = appointmentsSheet.getDataRange().getValues();
  const distribution = {};

  for (let i = 1; i < data.length; i++) {
    const appointmentDate = new Date(data[i][1]); // Column B is appointment date
    if (appointmentDate >= firstDayOfMonth) {
      const type = data[i][8]; // Column I is appointment type
      distribution[type] = (distribution[type] || 0) + 1;
    }
  }

  return distribution;
}

function getTodayAppointmentDistribution() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const appointmentsSheet = ss.getSheetByName("appointment");
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const data = appointmentsSheet.getDataRange().getValues();
  const distribution = {};

  for (let i = 1; i < data.length; i++) {
    const appointmentDate = new Date(data[i][1]); // Column B is appointment date
    appointmentDate.setHours(0, 0, 0, 0);

    // Only count today's appointments
    if (appointmentDate.getTime() === today.getTime()) {
      const type = data[i][8] || "Not Specified"; // Column I is appointment type
      distribution[type] = (distribution[type] || 0) + 1;
    }
  }

  return distribution;
}

function getWeeklyTrends() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const appointmentsSheet = ss.getSheetByName("appointment");
  const today = new Date();
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - today.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const data = appointmentsSheet.getDataRange().getValues();
  const weeklyData = [0, 0, 0, 0, 0, 0, 0]; // Initialize array for 7 days

  for (let i = 1; i < data.length; i++) {
    const appointmentDate = new Date(data[i][1]); // Column B is appointment date
    if (appointmentDate >= startOfWeek) {
      const dayIndex = appointmentDate.getDay();
      weeklyData[dayIndex]++;
    }
  }

  return weeklyData;
}

/**
 * Searches appointments based on various criteria
 * @param {Object} params - Search parameters
 * @param {string} params.mrdNo - MRD number to search for
 * @param {string} params.patientName - Patient name to search for
 * @param {string} params.phone - Phone number to search for
 * @param {string} params.fourDayConfirm - 4-day confirmation status
 * @param {string} params.oneDayConfirm - 1-day confirmation status
 * @param {number} params.page - Page number for pagination
 * @param {number} params.itemsPerPage - Number of items per page
 * @return {Object} Search results with appointments and total count
 */
function searchAppointments(params) {
  try {
    const sheet =
      SpreadsheetApp.getActiveSpreadsheet().getSheetByName("appointment");
    if (!sheet) {
      return {
        success: false,
        message: "Appointment sheet not found",
      };
    }

    const data = sheet.getDataRange().getValues();

    // Define the correct column mapping
    const columnMap = {
      AppointmentID: 0, // Column A
      AppointmentDate: 1, // Column B
      TimeSlot: 2, // Column C
      MRDNo: 3, // Column D
      PatientName: 4, // Column E
      Age: 5, // Column F
      Gender: 6, // Column G
      Phone: 7, // Column H
      AppointmentType: 8, // Column I
      Doctor: 9, // Column J
      PlanOfAction: 10, // Column K
      Remarks: 11, // Column L
      BookedBy: 12, // Column M
      BookingDate: 13, // Column N
      FourDayConfirmDate: 14, // Column O
      FourDayConfirmBy: 15, // Column P
      OneDayConfirmDate: 16, // Column Q
      OneDayConfirmBy: 17, // Column R
      FixedSlot: 25, // Column Z
      Tag: 31, // Column AF
    };

    // Handle remarks search - get AppointmentIDs from RemarksHistory sheet if remarks search is provided
    let remarksMatchedAppointmentIds = new Set();
    if (params.remarks && params.remarks.trim() !== "") {
      try {
        const remarksSheet = initializeRemarksHistorySheet();
        const remarksData = remarksSheet.getDataRange().getValues();
        const remarksSearchTerm = params.remarks.toLowerCase();

        // Search in column B (Remark) of RemarksHistory sheet
        // Column A (index 0) = AppointmentID, Column B (index 1) = Remark
        for (let i = 1; i < remarksData.length; i++) {
          const remarkText = remarksData[i][1]; // Column B
          if (
            remarkText &&
            remarkText.toString().toLowerCase().indexOf(remarksSearchTerm) !==
              -1
          ) {
            const appointmentId = remarksData[i][0]; // Column A
            if (appointmentId) {
              remarksMatchedAppointmentIds.add(appointmentId.toString());
            }
          }
        }
      } catch (remarksError) {}
    }

    // Filter appointments based on search criteria
    let filteredData = data.slice(1).filter((row) => {
      try {
        // MRD No filter
        if (
          params.mrdNo &&
          row[columnMap.MRDNo] &&
          row[columnMap.MRDNo]
            .toString()
            .toLowerCase()
            .indexOf(params.mrdNo.toLowerCase()) === -1
        ) {
          return false;
        }

        // Patient name filter
        if (
          params.patientName &&
          row[columnMap.PatientName] &&
          row[columnMap.PatientName]
            .toString()
            .toLowerCase()
            .indexOf(params.patientName.toLowerCase()) === -1
        ) {
          return false;
        }

        // Phone filter
        if (
          params.phone &&
          row[columnMap.Phone] &&
          row[columnMap.Phone]
            .toString()
            .toLowerCase()
            .indexOf(params.phone.toLowerCase()) === -1
        ) {
          return false;
        }

        // Remarks filter - search in column L of appointment sheet OR in RemarksHistory sheet
        if (params.remarks && params.remarks.trim() !== "") {
          const remarksSearchTerm = params.remarks.toLowerCase();
          const appointmentId = row[columnMap.AppointmentID]?.toString();
          const appointmentSheetRemarks =
            row[columnMap.Remarks]?.toString().toLowerCase() || "";

          // Check if remarks match in appointment sheet (column L) OR if appointment ID is in RemarksHistory matches
          const matchesAppointmentSheet =
            appointmentSheetRemarks.indexOf(remarksSearchTerm) !== -1;
          const matchesRemarksHistory =
            appointmentId && remarksMatchedAppointmentIds.has(appointmentId);

          // If neither matches, exclude this row
          if (!matchesAppointmentSheet && !matchesRemarksHistory) {
            return false;
          }
        }

        // Tag filter
        if (params.tag && params.tag.trim() !== "") {
          const tagString = row[columnMap.Tag]?.toString() || "";
          const tags = parseTagString(tagString);

          // Check if the selected tag exists in the appointment's tags
          if (!tags.includes(params.tag.trim())) {
            return false;
          }
        }

        // 4-day confirmation filter
        if (params.fourDayConfirm) {
          const isConfirmed = row[columnMap.FourDayConfirmDate] !== "";

          if (params.fourDayConfirm === "confirmed") {
            // Show confirmed appointments
            if (!isConfirmed) return false;
          } else if (params.fourDayConfirm === "pending") {
            // Show pending appointments that are coming in the next 4 days
            if (isConfirmed) return false; // Must be pending

            // Check if appointment date is within next 4 days
            const appointmentDate = row[columnMap.AppointmentDate];
            if (!appointmentDate) return false; // No appointment date, exclude

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const appointmentDateObj = new Date(appointmentDate);
            appointmentDateObj.setHours(0, 0, 0, 0);

            // Calculate days difference
            const daysDiff = Math.floor(
              (appointmentDateObj - today) / (1000 * 60 * 60 * 24),
            );

            // Only include if appointment is between today and 4 days from now (0 to 4 days)
            if (daysDiff < 0 || daysDiff > 4) {
              return false; // Appointment is not in the next 4 days
            }
          }
        }

        // 1-day confirmation filter
        if (params.oneDayConfirm) {
          const isConfirmed = row[columnMap.OneDayConfirmDate] !== "";
          if (params.oneDayConfirm === "confirmed" && !isConfirmed)
            return false;
          if (params.oneDayConfirm === "pending" && isConfirmed) return false;
        }

        return true;
      } catch (rowError) {
        return false;
      }
    });

    // Calculate pagination
    const startIndex = ((params.page || 1) - 1) * (params.itemsPerPage || 10);
    const endIndex = startIndex + (params.itemsPerPage || 10);
    const paginatedData = filteredData.slice(startIndex, endIndex);

    // Convert rows to appointment objects with proper formatting
    const appointments = paginatedData
      .map((row) => {
        try {
          const appointmentDate = row[columnMap.AppointmentDate]
            ? Utilities.formatDate(
                new Date(row[columnMap.AppointmentDate]),
                Session.getScriptTimeZone(),
                "yyyy-MM-dd",
              )
            : "";

          const timeSlot = row[columnMap.TimeSlot]
            ? Utilities.formatDate(
                new Date(row[columnMap.TimeSlot]),
                Session.getScriptTimeZone(),
                "HH:mm",
              )
            : "";

          // Check Fixed Slot value and log it
          const fixedSlotValue = row[columnMap.FixedSlot];

          // Convert FixedSlot to a more consistent value
          const isFixedSlot =
            fixedSlotValue === "Yes" ||
            fixedSlotValue === true ||
            fixedSlotValue === "true";

          return {
            AppointmentID: row[columnMap.AppointmentID]?.toString() || "",
            AppointmentDate: appointmentDate,
            TimeSlot: timeSlot,
            MRDNo: row[columnMap.MRDNo]?.toString() || "",
            PatientName: row[columnMap.PatientName]?.toString() || "",
            Age: row[columnMap.Age]?.toString() || "",
            Gender: row[columnMap.Gender]?.toString() || "",
            Phone: row[columnMap.Phone]?.toString() || "",
            AppointmentType: row[columnMap.AppointmentType]?.toString() || "",
            Doctor: row[columnMap.Doctor]?.toString() || "",
            PlanOfAction: row[columnMap.PlanOfAction]?.toString() || "-",
            Remarks: row[columnMap.Remarks]?.toString() || "-",
            FourDayConfirmDate: row[columnMap.FourDayConfirmDate]
              ? Utilities.formatDate(
                  new Date(row[columnMap.FourDayConfirmDate]),
                  Session.getScriptTimeZone(),
                  "yyyy-MM-dd",
                )
              : "",
            OneDayConfirmDate: row[columnMap.OneDayConfirmDate]
              ? Utilities.formatDate(
                  new Date(row[columnMap.OneDayConfirmDate]),
                  Session.getScriptTimeZone(),
                  "yyyy-MM-dd",
                )
              : "",
            FixedSlot: isFixedSlot,
            Tag: parseTagString(row[columnMap.Tag]),
          };
        } catch (error) {
          return null;
        }
      })
      .filter((appointment) => appointment !== null); // Remove any failed conversions

    return {
      success: true,
      appointments: appointments,
      total: filteredData.length,
    };
  } catch (error) {
    return {
      success: false,
      message: "Error searching appointments: " + error.toString(),
    };
  }
}

function getAppointmentDetails(appointmentId) {
  try {
    if (!appointmentId) {
      return {
        success: false,
        message: "No appointment ID provided",
        appointment: null,
      };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // Check both appointment and cancel sheets
    const appointmentSheet = ss.getSheetByName("appointment");
    const cancelSheet = ss.getSheetByName("cancel");

    if (!appointmentSheet && !cancelSheet) {
      return {
        success: false,
        message: "Required sheets not found",
        appointment: null,
      };
    }

    // Function to search in a sheet
    function searchInSheet(sheet) {
      if (!sheet) return null;
      const data = sheet.getDataRange().getValues();
      const headers = data[0];

      // Decode and clean the appointment ID
      const searchId = decodeURIComponent(appointmentId).trim();

      // Find the appointment row
      const rowIndex = data.findIndex((row, index) => {
        const currentId = row[0]?.toString().trim();
        return currentId === searchId;
      });

      if (rowIndex === -1) return null;

      // Build appointment object
      const appointment = {};
      headers.forEach((header, index) => {
        const value = data[rowIndex][index];
        let formattedValue;

        if (value instanceof Date) {
          // Format dates consistently
          formattedValue = Utilities.formatDate(
            value,
            Session.getScriptTimeZone(),
            "yyyy-MM-dd HH:mm:ss",
          );
        } else if (value === null || value === undefined) {
          formattedValue = "";
        } else {
          formattedValue = value.toString();
        }

        appointment[header] = formattedValue;
      });

      return appointment;
    }

    // First check appointment sheet, then cancel sheet
    const appointment =
      searchInSheet(appointmentSheet) || searchInSheet(cancelSheet);

    if (!appointment) {
      return {
        success: false,
        message: `Appointment not found for ID: ${appointmentId}`,
        errorCode: "APPOINTMENT_NOT_FOUND",
        appointment: null,
      };
    }

    const response = {
      success: true,
      message: "Appointment details loaded",
      appointment: appointment,
    };

    return response;
  } catch (e) {
    return {
      success: false,
      message: `Server error: ${e.toString()}`,
      errorDetails: e.stack,
      appointment: null,
    };
  }
}

function getRescheduleAllowedSlots(doctor, appointmentType, date) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("appointment");
    if (!sheet) {
      return { success: false, message: "Sheet not found." };
    }

    var dataRange = sheet.getDataRange();
    var values = dataRange.getValues();
    var headers = values[0];

    // Get column indices
    var doctorCol = headers.indexOf("Doctor");
    var typeCol = headers.indexOf("AppointmentType");
    var dateCol = headers.indexOf("AppointmentDate");
    var timeSlotCol = headers.indexOf("TimeSlot");

    if (
      doctorCol === -1 ||
      typeCol === -1 ||
      dateCol === -1 ||
      timeSlotCol === -1
    ) {
      return { success: false, message: "Required columns not found." };
    }

    // Get all booked slots for the date
    var bookedSlots = [];
    for (var i = 1; i < values.length; i++) {
      if (
        values[i][dateCol] &&
        Utilities.formatDate(
          new Date(values[i][dateCol]),
          Session.getScriptTimeZone(),
          "yyyy-MM-dd",
        ) === date
      ) {
        bookedSlots.push(
          Utilities.formatDate(
            new Date(values[i][timeSlotCol]),
            Session.getScriptTimeZone(),
            "HH:mm",
          ),
        );
      }
    }

    // Get all possible slots for the doctor and appointment type
    var allSlots = getAllTimeSlots(doctor, appointmentType);

    // Filter out booked slots
    var allowedSlots = allSlots.filter((slot) => !bookedSlots.includes(slot));

    return { success: true, allowedSlots: allowedSlots };
  } catch (e) {
    return {
      success: false,
      message:
        "An error occurred while fetching allowed slots for rescheduling: " +
        e.toString(),
    };
  }
}

function getAllTimeSlots(doctor, appointmentType) {
  // Define time slots based on doctor and appointment type
  // This is a simplified version - you may want to customize this based on your needs
  var slots = [];
  var startHour = 9; // 9 AM
  var endHour = 17; // 5 PM
  var interval = 30; // 30 minutes

  for (var hour = startHour; hour < endHour; hour++) {
    for (var minute = 0; minute < 60; minute += interval) {
      var time = Utilities.formatDate(
        new Date(2000, 0, 1, hour, minute),
        Session.getScriptTimeZone(),
        "HH:mm",
      );
      slots.push(time);
    }
  }
  return slots;
}

function cancelAppointment(
  appointmentId,
  sessionToken,
  callbackRequired = false,
) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentSheet = ss.getSheetByName("appointment");
    const cancelSheet = ss.getSheetByName("cancel");

    // Get the appointment data
    const data = appointmentSheet.getDataRange().getValues();
    const headers = data[0];
    const appointmentIdIndex = headers.indexOf("AppointmentID");

    // Find the appointment row index in the data array (including header)
    const appointmentRowIndex = data.findIndex(
      (row, index) => index > 0 && row[appointmentIdIndex] === appointmentId,
    );

    if (appointmentRowIndex === -1) {
      return {
        success: false,
        message: "Appointment not found",
      };
    }

    const appointment = data[appointmentRowIndex];

    // Create a copy of the appointment row to avoid modifying the original
    const cancelledAppointment = [...appointment];

    // Ensure the row has enough columns (extend to at least column AH - index 33)
    while (cancelledAppointment.length < 34) {
      cancelledAppointment.push("");
    }

    // Set columns O, P, Q, R, Z, AB, AC to null when moving to cancel sheet
    cancelledAppointment[14] = ""; // Column O
    cancelledAppointment[15] = ""; // Column P
    cancelledAppointment[16] = ""; // Column Q
    cancelledAppointment[17] = ""; // Column R
    cancelledAppointment[25] = ""; // Column Z
    cancelledAppointment[27] = ""; // Column AB
    cancelledAppointment[28] = ""; // Column AC

    // Add cancellation date and time to the correct columns to match searchCancelledAppointments expectations
    const now = new Date();
    const username = getSessionUsername(sessionToken);

    cancelledAppointment[21] = now; // DeletedOn - Column V (index 21)
    cancelledAppointment[22] = username || Session.getActiveUser().getEmail(); // DeletedBy - Column W (index 22)

    // Add callback flag to column AH (index 33)
    cancelledAppointment[33] = callbackRequired ? "Yes" : "";

    // ✅ ETERNAL TRACKING: Get existing journey BEFORE moving
    const appointmentJourneyColIndex = headers.indexOf("AppointmentJourney");
    let existingJourney = [];

    if (
      appointmentJourneyColIndex !== -1 &&
      appointment[appointmentJourneyColIndex]
    ) {
      try {
        existingJourney = JSON.parse(appointment[appointmentJourneyColIndex]);
      } catch (e) {
        existingJourney = [];
      }
    }

    // Add cancel journey entry
    existingJourney.push({
      timestamp: new Date().toISOString(),
      action: "cancelled",
      by: username,
      fromSheet: "appointment",
      toSheet: "cancel",
      description:
        "Appointment cancelled" +
        (callbackRequired ? " with callback requested" : ""),
      reason: callbackRequired ? "Callback required" : "Cancelled by user",
    });

    // Ensure cancel sheet has journey column
    const cancelJourneyColIndex = ensureJourneyColumn(cancelSheet);

    // Ensure cancelledAppointment array has enough columns for journey
    while (
      cancelledAppointment.length < Math.max(cancelSheet.getLastColumn(), 36)
    ) {
      cancelledAppointment.push("");
    }

    // Copy journey data to cancelled appointment row
    if (cancelJourneyColIndex !== -1) {
      cancelledAppointment[cancelJourneyColIndex] =
        JSON.stringify(existingJourney);
    }

    // Migrate tags from appointment sheet to cancel sheet (column AF - index 31)
    const TAG_COLUMN_INDEX = 31;
    const tagString = appointment[TAG_COLUMN_INDEX] || "";
    if (tagString && tagString.trim() !== "") {
      // Ensure cancelledAppointment has enough columns for tags
      while (cancelledAppointment.length <= TAG_COLUMN_INDEX) {
        cancelledAppointment.push("");
      }
      cancelledAppointment[TAG_COLUMN_INDEX] = tagString;
    }

    // Add to cancel sheet
    cancelSheet.appendRow(cancelledAppointment);

    // Delete from appointment sheet using the correct row index
    appointmentSheet.deleteRow(appointmentRowIndex + 1);

    // Verify tags were migrated successfully
    if (tagString && tagString.trim() !== "") {
      const verifyResult = getAppointmentTags(appointmentId, "cancel");
      if (verifyResult.success && verifyResult.tags.length > 0) {
      } else {
      }
    }

    // Log audit event for appointment cancellation
    try {
      logAuditEvent(
        sessionToken,
        "CANCEL_APPOINTMENT",
        "APPOINTMENT",
        appointmentId,
        {
          date: appointment[1], // AppointmentDate - Column B
          time: appointment[2], // TimeSlot - Column C
          mrdNo: appointment[3], // MRDNo - Column D
          patientName: appointment[4], // Name - Column E
          reason: callbackRequired ? "Callback required" : "Cancelled by user",
          callbackRequired: callbackRequired,
          sheetName: "cancel",
        },
      );
    } catch (auditError) {
      // Don't fail cancellation if audit logging fails
      Logger.log(
        "Audit logging failed for appointment cancellation: " +
          auditError.toString(),
      );
    }

    return {
      success: true,
      message:
        "Appointment cancelled successfully" +
        (callbackRequired ? " with callback scheduled" : ""),
    };
  } catch (error) {
    return {
      success: false,
      message: "Error cancelling appointment: " + error.toString(),
    };
  }
}

/**
 * Search patients based on various criteria
 * @param {Object} searchParams - Search parameters
 * @param {string} searchParams.mrdNo - MRD number to search for
 * @param {string} searchParams.patientName - Patient name to search for
 * @param {string} searchParams.phone - Phone number to search for
 * @param {string} searchParams.type - Patient type to search for
 * @param {string} searchParams.status - Patient status to search for
 * @param {number} searchParams.page - Page number for pagination
 * @param {number} searchParams.itemsPerPage - Number of items per page
 * @return {Object} Search results with patients and total count
 */
function searchPatients(searchParams) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const patientMasterSheet = ss.getSheetByName("patientMaster");
    //const tempPatientMasterSheet = ss.getSheetByName("tempPatientMaster");

    if (!patientMasterSheet) {
      return {
        success: false,
        message: "Patient master sheet not found",
      };
    }

    // Define the correct column mapping
    const columnMap = {
      MRDNo: 0, // Column A
      Name: 1, // Column B
      DOB: 2, // Column C
      Gender: 3, // Column D
      Phone: 4, // Column E
      Address: 5, // Column F
      HomeNo: 6, // Column G
      WorkNo: 7, // Column H
      RegisteredOn: 8, // Column I
      Type: 9, // Column J
      AdditionalInfo: 10, // Column K
      Status: 11, // Column L
    };

    // Function to filter data from a sheet
    function filterSheetData(sheet) {
      if (!sheet) return [];
      const data = sheet.getDataRange().getValues();
      return data.slice(1).filter((row) => {
        try {
          // MRD No filter - exact numeric match only
          if (searchParams.mrdNo) {
            const searchValue = searchParams.mrdNo.trim();
            const rowMRD = row[columnMap.MRDNo]
              ? row[columnMap.MRDNo].toString().trim()
              : "";

            if (!rowMRD) {
              return false;
            }

            // Extract numeric part from both search value and row MRD
            const extractNumeric = (str) => {
              const match = str.toString().match(/\d+/);
              return match ? match[0] : "";
            };

            const searchNumeric = extractNumeric(searchValue);
            const rowNumeric = extractNumeric(rowMRD);

            // If search value contains numbers, match numeric part exactly
            // If search value is full MRD (like "SPD22"), match full string (case-insensitive)
            if (searchNumeric) {
              // User searched for a number - match numeric part exactly
              if (rowNumeric !== searchNumeric) {
                return false;
              }
            } else {
              // User searched for text without numbers - match full string (case-insensitive)
              if (rowMRD.toLowerCase() !== searchValue.toLowerCase()) {
                return false;
              }
            }
          }

          // Patient name filter
          if (
            searchParams.patientName &&
            row[columnMap.Name] &&
            row[columnMap.Name]
              .toString()
              .toLowerCase()
              .indexOf(searchParams.patientName.toLowerCase()) === -1
          ) {
            return false;
          }

          // Phone filter
          if (
            searchParams.phone &&
            row[columnMap.Phone] &&
            row[columnMap.Phone]
              .toString()
              .toLowerCase()
              .indexOf(searchParams.phone.toLowerCase()) === -1
          ) {
            return false;
          }

          // Type filter - handle multiple types (comma-separated or array)
          if (searchParams.type && searchParams.type.length > 0) {
            const patientTypes = row[columnMap.Type]
              ? row[columnMap.Type]
                  .toString()
                  .split(",")
                  .map((t) => t.trim().toLowerCase())
                  .filter((t) => t)
              : [];

            // Convert searchParams.type to array if it's a string
            const searchTypes = Array.isArray(searchParams.type)
              ? searchParams.type.map((t) => t.toString().toLowerCase())
              : [searchParams.type.toString().toLowerCase()];

            // Check if any of the search types match any of the patient's types
            const hasMatchingType = searchTypes.some((searchType) =>
              patientTypes.some((patientType) => patientType === searchType),
            );

            if (!hasMatchingType) {
              return false;
            }
          }

          // Status filter
          if (
            searchParams.status &&
            row[columnMap.Status] &&
            row[columnMap.Status].toString().toLowerCase() !==
              searchParams.status.toLowerCase()
          ) {
            return false;
          }

          return true;
        } catch (rowError) {
          return false;
        }
      });
    }

    // Get filtered data only from patientMaster sheet (not from tempPatientMaster)
    let filteredData = filterSheetData(patientMasterSheet);

    // Calculate pagination
    const startIndex =
      ((searchParams.page || 1) - 1) * (searchParams.itemsPerPage || 10);
    const endIndex = startIndex + (searchParams.itemsPerPage || 10);
    const paginatedData = filteredData.slice(startIndex, endIndex);

    // Convert rows to patient objects with proper formatting
    const patients = paginatedData
      .map((row) => {
        try {
          return {
            MRDNo: row[columnMap.MRDNo]?.toString() || "",
            Name: row[columnMap.Name]?.toString() || "",
            DOB: row[columnMap.DOB]
              ? Utilities.formatDate(
                  new Date(row[columnMap.DOB]),
                  Session.getScriptTimeZone(),
                  "yyyy-MM-dd",
                )
              : "",
            Gender: row[columnMap.Gender]?.toString() || "",
            Phone: row[columnMap.Phone]?.toString() || "",
            Address: row[columnMap.Address]?.toString() || "",
            HomeNo: row[columnMap.HomeNo]?.toString() || "",
            WorkNo: row[columnMap.WorkNo]?.toString() || "",
            Type: row[columnMap.Type]?.toString() || "",
            AdditionalInfo: row[columnMap.AdditionalInfo]?.toString() || "",
            Status: row[columnMap.Status]?.toString() || "",
            RegisteredOn: row[columnMap.RegisteredOn]
              ? Utilities.formatDate(
                  new Date(row[columnMap.RegisteredOn]),
                  Session.getScriptTimeZone(),
                  "yyyy-MM-dd HH:mm:ss",
                )
              : "",
          };
        } catch (error) {
          return null;
        }
      })
      .filter((patient) => patient !== null); // Remove any failed conversions

    return {
      success: true,
      patients: patients,
      total: filteredData.length,
    };
  } catch (error) {
    return {
      success: false,
      message: "Error searching patients: " + error.toString(),
    };
  }
}

/**
 * Get details of a specific patient
 * @param {string} mrdNo - MRD number of the patient
 * @return {Object} Patient details
 */
function getPatientDetails(mrdNo) {
  try {
    const sheet =
      SpreadsheetApp.getActiveSpreadsheet().getSheetByName("patientMaster");
    if (!sheet) {
      return {
        success: false,
        message: "Patient master sheet not found",
      };
    }

    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    // Find the patient row
    const patientRow = data.slice(1).find((row) => row[0].toString() === mrdNo);

    if (!patientRow) {
      return {
        success: false,
        message: "Patient not found",
      };
    }

    // Helper function to calculate exact age difference
    function calculateExactAge(dob) {
      var today = new Date();
      var birthDate = new Date(dob);

      // Calculate difference in milliseconds
      var diffInMs = today.getTime() - birthDate.getTime();
      var diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));

      if (diffInDays < 30) {
        // Less than 30 days - return in days
        return diffInDays + " days";
      } else if (diffInDays < 365) {
        // 30 days or more but less than a year - return in months
        var months = Math.floor(diffInDays / 30);
        return months + " months";
      } else {
        // A year or more - return in years
        var years = Math.floor(diffInDays / 365);
        return years + " years";
      }
    }

    // Calculate exact age from DOB
    const dob = new Date(patientRow[2]);
    const exactAge = calculateExactAge(dob);

    return {
      success: true,
      patient: {
        MRDNo: patientRow[0],
        Name: patientRow[1],
        DOB: Utilities.formatDate(
          dob,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd",
        ),
        Age: exactAge,
        Gender: patientRow[3],
        Phone: patientRow[4],
        Address: patientRow[5],
        HomeNo: patientRow[6] || "",
        WorkNo: patientRow[7] || "",
        RegisteredOn: patientRow[8]
          ? Utilities.formatDate(
              new Date(patientRow[8]),
              Session.getScriptTimeZone(),
              "yyyy-MM-dd HH:mm:ss",
            )
          : "",
        Type: patientRow[9] || "",
        AdditionalInfo: patientRow[10] || "",
        Status: patientRow[11] || "",
      },
    };
  } catch (error) {
    return {
      success: false,
      message: "Error getting patient details: " + error.toString(),
    };
  }
}

/**
 * Update patient details
 * @param {Object} updatedData - Updated patient data
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Update status
 */
function updatePatientDetails(updatedData, sessionToken) {
  try {
    // Handle both naming conventions (lowercase from frontend, uppercase for consistency)
    const mrdNo = updatedData.mrdNo || updatedData.MRDNo;
    const name = updatedData.name || updatedData.Name;
    const dob = updatedData.dob || updatedData.DOB;
    const gender = updatedData.gender || updatedData.Gender;
    const phone = updatedData.phone || updatedData.Phone;
    const address = updatedData.address || updatedData.Address;
    const homeNo = updatedData.homeNo || updatedData.HomeNo || "";
    const workNo = updatedData.workNo || updatedData.WorkNo || "";
    const type = updatedData.type || updatedData.Type || "";
    const additionalInfo =
      updatedData.additionalInfo || updatedData.AdditionalInfo || "";

    // Verify admin access
    const session = getUserSession(sessionToken);
    if (!session || session.role !== "admin") {
      return {
        success: false,
        message: "Unauthorized access. Admin or Manager privileges required.",
      };
    }

    const sheet =
      SpreadsheetApp.getActiveSpreadsheet().getSheetByName("patientMaster");
    if (!sheet) {
      return {
        success: false,
        message: "Patient master sheet not found",
      };
    }

    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    // Find the patient row
    const rowIndex = data.findIndex((row) => row[0].toString() === mrdNo);

    if (rowIndex === -1) {
      return {
        success: false,
        message: "Patient not found",
      };
    }

    // Update the values
    const updateRow = rowIndex + 1; // +1 for header row
    sheet.getRange(updateRow, 2).setValue(name); // Column B
    sheet.getRange(updateRow, 3).setValue(new Date(dob)); // Column C
    sheet.getRange(updateRow, 4).setValue(gender); // Column D
    sheet.getRange(updateRow, 5).setValue(phone); // Column E
    sheet.getRange(updateRow, 6).setValue(address); // Column F
    sheet.getRange(updateRow, 7).setValue(homeNo); // Column G
    sheet.getRange(updateRow, 8).setValue(workNo); // Column H
    sheet.getRange(updateRow, 10).setValue(type); // Column J
    sheet.getRange(updateRow, 11).setValue(additionalInfo); // Column K

    logAuditEvent(sessionToken, "UPDATE_PATIENT", "PATIENT", mrdNo, { name: name, phone: phone, gender: gender, type: type, sheetName: "patientMaster" });

    return {
      success: true,
      message: "Patient details updated successfully",
    };
  } catch (error) {
    return {
      success: false,
      message: "Error updating patient details: " + error.toString(),
    };
  }
}

/**
 * Toggle patient status between Active and Inactive
 * @param {string} mrdNo - MRD number of the patient
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Toggle status
 */
function togglePatientStatus(mrdNo, sessionToken) {
  try {
    // Verify admin access
    const session = getUserSession(sessionToken);
    if (!session || session.role !== "admin") {
      return {
        success: false,
        message: "Unauthorized access",
      };
    }

    const sheet =
      SpreadsheetApp.getActiveSpreadsheet().getSheetByName("patientMaster");
    if (!sheet) {
      return {
        success: false,
        message: "Patient master sheet not found",
      };
    }

    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    // Find the patient row
    const rowIndex = data.findIndex((row) => row[0].toString() === mrdNo);

    if (rowIndex === -1) {
      return {
        success: false,
        message: "Patient not found",
      };
    }

    // Toggle status
    const currentStatus = data[rowIndex][11]; // Column L
    const newStatus = currentStatus === "Active" ? "Inactive" : "Active";

    sheet.getRange(rowIndex + 1, 12).setValue(newStatus); // +1 for header row, Column L

    logAuditEvent(sessionToken, "TOGGLE_PATIENT_STATUS", "PATIENT", mrdNo, { previousStatus: currentStatus, newStatus: newStatus, sheetName: "patientMaster" });

    return {
      success: true,
      message: "Patient status toggled successfully",
      newStatus: newStatus,
    };
  } catch (error) {
    return {
      success: false,
      message: "Error toggling patient status: " + error.toString(),
    };
  }
}

function getReschedulePageUrl(appointmentId) {
  var sessionToken = Session.getActiveUser().getEmail();
  return (
    ScriptApp.getService().getUrl() +
    "?page=rescheduleAppointment&appointmentId=" +
    appointmentId +
    "&sessionToken=" +
    sessionToken
  );
}

function showReschedulePage(appointmentId) {
  var template = HtmlService.createTemplateFromFile("rescheduleAppointment");
  template.appointmentId = appointmentId;
  template.sessionToken = Session.getActiveUser().getEmail();
  template.webAppUrl = ScriptApp.getService().getUrl();

  return template
    .evaluate()
    .setTitle("Reschedule Appointment")
    .addMetaTag("viewport", "width=device-width, initial-scale=1.0");
}

/**
 * Check if the user is an admin (Level 1 access)
 * @param {string} sessionToken - The session token to check
 * @return {boolean} True if the user is an admin
 */
function isAdmin(sessionToken) {
  return hasAdminAccess(sessionToken);
}
/**
 * Get the email address of the logged-in user
 * @param {string} sessionToken - The session token
 * @return {Object} Object containing success status and email address
 */
function getUserEmail(sessionToken) {
  try {
    const session = getUserSession(sessionToken);
    if (!session) {
      return { success: false, message: "Invalid session" };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("Login");
    if (!sheet) {
      return { success: false, message: "Login sheet not found" };
    }

    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === session.username) {
        return { success: true, email: data[i][4] }; // Email is in column E
      }
    }

    return { success: false, message: "User email not found" };
  } catch (error) {
    return { success: false, message: error.toString() };
  }
}

/**
 * Send day overview email
 * @param {string} date - The date to send overview for
 * @param {string} sessionToken - The session token
 * @return {Object} Object containing success status and recipient email
 */
function sendDayOverviewEmail(date, sessionToken) {
  try {
    // Initialize spreadsheet
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // Get user email
    const userEmailResponse = getUserEmail(sessionToken);
    if (!userEmailResponse.success) {
      return { success: false, message: userEmailResponse.message };
    }
    const recipientEmail = userEmailResponse.email;

    // Get appointments for the day
    const appointments = getAppointmentsForDay(date);
    if (!appointments || appointments.length === 0) {
      return {
        success: false,
        message: "No appointments found for the selected date",
      };
    }

    // Separate waiting list appointments from regular appointments
    const regularAppointments = appointments.filter(
      (appt) => appt.AppointmentType !== "WAITING LIST",
    );
    const waitingListAppointments = appointments.filter(
      (appt) => appt.AppointmentType === "WAITING LIST",
    );

    // Sort regular appointments by time
    regularAppointments.sort((a, b) => {
      const timeA = a.TimeSlot ? new Date(a.TimeSlot).getTime() : 0;
      const timeB = b.TimeSlot ? new Date(b.TimeSlot).getTime() : 0;
      return timeA - timeB;
    });

    // Sort waiting list appointments by patient name (alphabetically)
    waitingListAppointments.sort((a, b) => {
      const nameA = (a.PatientName || "").toUpperCase();
      const nameB = (b.PatientName || "").toUpperCase();
      return nameA.localeCompare(nameB);
    });

    // Combine: regular appointments first, then waiting list at the end
    const sortedAppointments = [
      ...regularAppointments,
      ...waitingListAppointments,
    ];

    // Create email content
    const formattedDate = Utilities.formatDate(
      new Date(date),
      Session.getScriptTimeZone(),
      "EEEE, MMMM d, yyyy",
    );
    const subject = `Day Overview Report - ${formattedDate}`;

    // Count appointments by type and plan of action
    const summary = {
      total: sortedAppointments.length,
      confirmed: 0,
      waitingList: 0,
      planOfAction: {}, // Object to store plan of action counts
    };

    sortedAppointments.forEach((appt) => {
      if (appt.AppointmentType === "WAITING LIST") {
        summary.waitingList++;
      } else {
        summary.confirmed++;
      }

      // Count plan of action
      if (appt.PlanOfAction) {
        try {
          const plans = JSON.parse(appt.PlanOfAction);
          const planArray = Array.isArray(plans) ? plans : [plans];
          planArray.forEach((plan) => {
            let planName =
              typeof plan === "object" ? plan.name : plan.toString().trim();
            // Remove eye specifications (LE, RE, BE) from the plan name
            planName = planName.replace(/\s*\([LRB]E\)/g, "").trim();
            summary.planOfAction[planName] =
              (summary.planOfAction[planName] || 0) + 1;
          });
        } catch (e) {
          // If not JSON, treat as single plan
          let planName = appt.PlanOfAction.toString().trim();
          // Remove eye specifications (LE, RE, BE) from the plan name
          planName = planName.replace(/\s*\([LRB]E\)/g, "").trim();
          summary.planOfAction[planName] =
            (summary.planOfAction[planName] || 0) + 1;
        }
      }
    });

    // Get available slots count
    const availableSlotsResp = getAvailableSlotsCount();
    const availableSlots = availableSlotsResp.count || 0;

    // Get blocked slots count for each doctor
    const doctorsResponse = getDoctors();
    let totalBlockedSlots = 0;

    if (
      doctorsResponse &&
      doctorsResponse.success &&
      Array.isArray(doctorsResponse.doctors)
    ) {
      doctorsResponse.doctors.forEach(function (doctor) {
        const blockedSlots = getBlockedSlotsCount(doctor, date);
        totalBlockedSlots += blockedSlots;
      });
    }

    // Create HTML content with print-friendly styles
    let htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          @media print {
            body { margin: 0; padding: 0; }
            .page { margin: 0; padding: 0; }
            .no-print { display: none; }
          }
          
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            margin: 0;
            padding: 0;
          }
          
          .page {
            width: 210mm;
            min-height: 297mm;
            padding: 20mm;
            margin: 0 auto;
            background: white;
            box-sizing: border-box;
          }
          
          .header {
            text-align: center;
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 2px solid #2c5282;
          }
          
          .header h1 {
            color: #2c5282;
            margin: 0;
            font-size: 24px;
          }
          
          .header h2 {
            color: #4a5568;
            margin: 10px 0 0;
            font-size: 18px;
            font-weight: normal;
          }
          
          .summary-section {
            background-color: #f8fafc;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 30px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.05);
          }
          
          .summary-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 20px;
            margin-bottom: 20px;
          }
          
          .summary-item {
            background: white;
            padding: 15px;
            border-radius: 6px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
          }
          
          .summary-item h3 {
            margin: 0 0 10px;
            color: #2d3748;
            font-size: 16px;
          }
          
          .summary-value {
            font-size: 24px;
            font-weight: bold;
            color: #2c5282;
          }
          
          .plan-breakdown {
            background: white;
            padding: 15px;
            border-radius: 6px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
          }
          
          .plan-breakdown h3 {
            margin: 0 0 15px;
            color: #2d3748;
            font-size: 16px;
          }
          
          .plan-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
            gap: 10px;
          }
          
          .plan-item {
            display: flex;
            justify-content: space-between;
            padding: 8px;
            background: #f8fafc;
            border-radius: 4px;
          }
          
          .appointments-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
            font-size: 12px;
          }
          
          .appointments-table th {
            background-color: #2c5282;
            color: white;
            padding: 12px;
            text-align: left;
            border: 1px solid #e2e8f0;
          }
          
          .appointments-table td {
            padding: 10px;
            border: 1px solid #e2e8f0;
          }
          
          .appointments-table tr:nth-child(even) {
            background-color: #f8fafc;
          }
          
          .waiting-list {
            background-color: #f3e8ff !important;
          }
          
          .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #e2e8f0;
            text-align: center;
            color: #718096;
            font-size: 12px;
          }
        </style>
      </head>
      <body>
        <div class="page">
          <div class="header">
            <h1>Day Overview Report</h1>
            <h2>${formattedDate}</h2>
          </div>

          <div class="summary-section">
            <div class="summary-grid">
              <div class="summary-item">
                <h3>Total Appointments</h3>
                <div class="summary-value">${summary.total}</div>
              </div>
              <div class="summary-item">
                <h3>Confirmed Appointments</h3>
                <div class="summary-value">${summary.confirmed}</div>
              </div>
              <div class="summary-item">
                <h3>Waiting List</h3>
                <div class="summary-value">${summary.waitingList}</div>
              </div>
              <div class="summary-item">
                <h3>Available Slots</h3>
                <div class="summary-value">${availableSlots}</div>
              </div>
              <div class="summary-item">
                <h3>Free Blocked Slots</h3>
                <div class="summary-value">${totalBlockedSlots}</div>
              </div>
            </div>

            <div class="plan-breakdown">
              <h3>Plan of Action Breakdown</h3>
              <div class="plan-grid">
                ${Object.entries(summary.planOfAction)
                  .map(
                    ([plan, count]) => `
                    <div class="plan-item">
                      <span>${plan}</span>
                      <span style="font-weight: bold;">${count}</span>
                    </div>
                  `,
                  )
                  .join("")}
              </div>
            </div>
          </div>

          <table class="appointments-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>MRD</th>
                <th>Name</th>
                <th>Gender</th>
                <th>Age</th>
                <th>Phone</th>
                <th>Patient Type</th>
                <th>Plan</th>
                <th>Remarks</th>
              </tr>
            </thead>
            <tbody>
              ${sortedAppointments
                .map((appt) => {
                  // For waiting list appointments, show "-" instead of time
                  const isWaitingList = appt.AppointmentType === "WAITING LIST";
                  const timeDisplay =
                    isWaitingList ||
                    !appt.TimeSlot ||
                    appt.TimeSlot === "" ||
                    appt.TimeSlot === "undefined"
                      ? "-"
                      : Utilities.formatDate(
                          new Date(appt.TimeSlot),
                          Session.getScriptTimeZone(),
                          "hh:mm a",
                        );
                  return `
                <tr class="${isWaitingList ? "waiting-list" : ""}">
                  <td>${timeDisplay}</td>
                  <td>${appt.MRDNo}</td>
                  <td>${appt.PatientName}</td>
                  <td>${appt.Gender}</td>
                  <td>${appt.Age}</td>
                  <td>${appt.Phone}</td>
                  <td>${appt.PatientType || "-"}</td>
                  <td>${appt.PlanOfAction || "-"}</td>
                  <td>${appt.Remarks || "-"}</td>
                </tr>
              `;
                })
                .join("")}
            </tbody>
          </table>

          <div class="footer">
            <p>This is an automated report generated from the Appointment Management System.</p>
            <p>Generated on ${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "MMMM d, yyyy 'at' hh:mm a")}</p>
          </div>
        </div>
      </body>
      </html>
    `;

    // Send email
    MailApp.sendEmail({
      to: recipientEmail,
      subject: subject,
      htmlBody: htmlContent,
    });

    // Log the email send in audit sheet
    const auditSheet =
      ss.getSheetByName("EmailAudit") || ss.insertSheet("EmailAudit");
    if (auditSheet.getLastRow() === 0) {
      auditSheet.appendRow([
        "Timestamp",
        "Date",
        "Recipient",
        "Sent By",
        "Status",
      ]);
    }
    auditSheet.appendRow([
      new Date(),
      date,
      recipientEmail,
      userEmailResponse.username,
      "Success",
    ]);

    logAuditEvent(sessionToken, "SEND_DAY_OVERVIEW_EMAIL", "REPORT", date, { date: date, recipient: recipientEmail, appointmentCount: sortedAppointments.length, sheetName: "appointment" });

    return {
      success: true,
      message: "Email sent successfully",
      recipient: recipientEmail,
    };
  } catch (error) {
    return { success: false, message: error.toString() };
  }
}

/**
 * Search cancelled appointments based on various criteria
 * @param {Object} params - Search parameters
 * @param {string} params.mrdNo - MRD number to search for
 * @param {string} params.patientName - Patient name to search for
 * @param {string} params.phone - Phone number to search for
 * @param {number} params.page - Page number for pagination
 * @param {number} searchParams.itemsPerPage - Number of items per page
 * @return {Object} Search results with appointments and total count
 */
function searchCancelledAppointments(params) {
  try {
    const sheet =
      SpreadsheetApp.getActiveSpreadsheet().getSheetByName("cancel");
    if (!sheet) {
      return {
        success: false,
        message: "Cancel sheet not found",
      };
    }

    const data = sheet.getDataRange().getValues();

    // Define the correct column mapping
    const columnMap = {
      AppointmentID: 0, // Column A
      AppointmentDate: 1, // Column B
      TimeSlot: 2, // Column C
      MRDNo: 3, // Column D
      PatientName: 4, // Column E
      Age: 5, // Column F
      Gender: 6, // Column G
      Phone: 7, // Column H
      AppointmentType: 8, // Column I
      Doctor: 9, // Column J
      PlanOfAction: 10, // Column K
      Remarks: 11, // Column L
      BookedBy: 12, // Column M
      BookingDate: 13, // Column N
      FourDayConfirmDate: 14, // Column O
      FourDayConfirmBy: 15, // Column P
      OneDayConfirmDate: 16, // Column Q
      OneDayConfirmBy: 17, // Column R
      RescheduledDate: 18, // Column S
      RescheduledBy: 19, // Column T
      RescheduleHistory: 20, // Column U
      DeletedOn: 21, // Column V
      DeletedBy: 22, // Column W
      Tag: 31, // Column AF
      ColumnAH: 33, // Column AH
      CallbackDate: 34, // Column AI
    };

    // Get today's date for overdue calculation
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Handle remarks search - get AppointmentIDs from RemarksHistory sheet if remarks search is provided
    let remarksMatchedAppointmentIds = new Set();
    if (params.remarks && params.remarks.trim() !== "") {
      try {
        const remarksSheet = initializeRemarksHistorySheet();
        const remarksData = remarksSheet.getDataRange().getValues();
        const remarksSearchTerm = params.remarks.toLowerCase();

        // Search in column B (Remark) of RemarksHistory sheet
        // Column A (index 0) = AppointmentID, Column B (index 1) = Remark
        for (let i = 1; i < remarksData.length; i++) {
          const remarkText = remarksData[i][1]; // Column B
          if (
            remarkText &&
            remarkText.toString().toLowerCase().indexOf(remarksSearchTerm) !==
              -1
          ) {
            const appointmentId = remarksData[i][0]; // Column A
            if (appointmentId) {
              remarksMatchedAppointmentIds.add(appointmentId.toString());
            }
          }
        }
      } catch (remarksError) {}
    }

    // Filter appointments based on search criteria
    let filteredData = data.slice(1).filter((row) => {
      try {
        // MRD No filter
        if (
          params.mrdNo &&
          row[columnMap.MRDNo] &&
          row[columnMap.MRDNo]
            .toString()
            .toLowerCase()
            .indexOf(params.mrdNo.toLowerCase()) === -1
        ) {
          return false;
        }

        // Patient name filter
        if (
          params.patientName &&
          row[columnMap.PatientName] &&
          row[columnMap.PatientName]
            .toString()
            .toLowerCase()
            .indexOf(params.patientName.toLowerCase()) === -1
        ) {
          return false;
        }

        // Phone filter
        if (
          params.phone &&
          row[columnMap.Phone] &&
          row[columnMap.Phone]
            .toString()
            .toLowerCase()
            .indexOf(params.phone.toLowerCase()) === -1
        ) {
          return false;
        }

        // Remarks filter - search in column L of cancel sheet OR in RemarksHistory sheet
        if (params.remarks && params.remarks.trim() !== "") {
          const remarksSearchTerm = params.remarks.toLowerCase();
          const appointmentId = row[columnMap.AppointmentID]?.toString();
          const cancelSheetRemarks =
            row[columnMap.Remarks]?.toString().toLowerCase() || "";

          // Check if remarks match in cancel sheet (column L) OR if appointment ID is in RemarksHistory matches
          const matchesCancelSheet =
            cancelSheetRemarks.indexOf(remarksSearchTerm) !== -1;
          const matchesRemarksHistory =
            appointmentId && remarksMatchedAppointmentIds.has(appointmentId);

          // If neither matches, exclude this row
          if (!matchesCancelSheet && !matchesRemarksHistory) {
            return false;
          }
        }

        // Tag filter
        if (params.tag && params.tag.trim() !== "") {
          const tagString = row[columnMap.Tag]?.toString() || "";
          const tags = parseTagString(tagString);

          // Check if the selected tag exists in the appointment's tags
          if (!tags.includes(params.tag.trim())) {
            return false;
          }
        }

        // Callback date range filter
        if (params.callbackFrom || params.callbackTo) {
          const callbackDate = row[columnMap.CallbackDate];
          if (callbackDate) {
            const cbDate = new Date(callbackDate);
            if (params.callbackFrom) {
              const fromDate = new Date(params.callbackFrom);
              if (cbDate < fromDate) return false;
            }
            if (params.callbackTo) {
              const toDate = new Date(params.callbackTo);
              if (cbDate > toDate) return false;
            }
          } else if (params.callbackFrom || params.callbackTo) {
            // If filtering by callback date but appointment has no callback date, exclude it
            return false;
          }
        }

        // Card color filter
        if (params.cardColor) {
          const isPastelMauve =
            row[columnMap.ColumnAH] &&
            row[columnMap.ColumnAH].toString().toLowerCase() === "yes";
          const callbackDate = row[columnMap.CallbackDate];
          const isOverdue = callbackDate && new Date(callbackDate) < today;

          switch (params.cardColor) {
            case "overdue":
              if (!isOverdue) return false;
              break;
            case "pastel-mauve":
              if (!isPastelMauve) return false;
              break;
            case "ontime":
              if (isOverdue || isPastelMauve) return false;
              break;
          }
        }

        return true;
      } catch (rowError) {
        return false;
      }
    });

    // Calculate pagination
    const startIndex = ((params.page || 1) - 1) * (params.itemsPerPage || 10);
    const endIndex = startIndex + (params.itemsPerPage || 10);
    const paginatedData = filteredData.slice(startIndex, endIndex);

    // Convert rows to appointment objects with proper formatting
    const appointments = paginatedData
      .map((row) => {
        try {
          const appointmentDate = row[columnMap.AppointmentDate]
            ? Utilities.formatDate(
                new Date(row[columnMap.AppointmentDate]),
                Session.getScriptTimeZone(),
                "yyyy-MM-dd",
              )
            : "";

          const timeSlot = row[columnMap.TimeSlot]
            ? Utilities.formatDate(
                new Date(row[columnMap.TimeSlot]),
                Session.getScriptTimeZone(),
                "HH:mm",
              )
            : "";

          // Calculate status flags
          const isPastelMauve =
            row[columnMap.ColumnAH] &&
            row[columnMap.ColumnAH].toString().toLowerCase() === "yes";
          const callbackDate = row[columnMap.CallbackDate];
          const isOverdue = callbackDate && new Date(callbackDate) < today;

          const callbackDateFormatted = callbackDate
            ? Utilities.formatDate(
                new Date(callbackDate),
                Session.getScriptTimeZone(),
                "yyyy-MM-dd",
              )
            : "";

          return {
            AppointmentID: row[columnMap.AppointmentID]?.toString() || "",
            AppointmentDate: appointmentDate,
            TimeSlot: timeSlot,
            MRDNo: row[columnMap.MRDNo]?.toString() || "",
            PatientName: row[columnMap.PatientName]?.toString() || "",
            Age: row[columnMap.Age]?.toString() || "",
            Gender: row[columnMap.Gender]?.toString() || "",
            Phone: row[columnMap.Phone]?.toString() || "",
            AppointmentType: row[columnMap.AppointmentType]?.toString() || "",
            Doctor: row[columnMap.Doctor]?.toString() || "",
            PlanOfAction: row[columnMap.PlanOfAction]?.toString() || "-",
            Remarks: row[columnMap.Remarks]?.toString() || "-",
            DeletedOn: row[columnMap.DeletedOn]
              ? Utilities.formatDate(
                  new Date(row[columnMap.DeletedOn]),
                  Session.getScriptTimeZone(),
                  "yyyy-MM-dd HH:mm",
                )
              : "",
            DeletedBy: row[columnMap.DeletedBy]?.toString() || "",
            RescheduleHistory:
              row[columnMap.RescheduleHistory]?.toString() || "",
            CallbackDate: callbackDateFormatted,
            isOverdue: isOverdue,
            isPastelMauve: isPastelMauve,
            ColumnAH: row[columnMap.ColumnAH]?.toString() || "",
            Tag: parseTagString(row[columnMap.Tag]),
          };
        } catch (error) {
          return null;
        }
      })
      .filter((appointment) => appointment !== null);

    return {
      success: true,
      appointments: appointments,
      total: filteredData.length,
    };
  } catch (error) {
    return {
      success: false,
      message: "Error searching cancelled appointments: " + error.toString(),
    };
  }
}

/**
 * Update a cancelled appointment's details
 * @param {Object} updatedData - Updated appointment data
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Update status
 */
function updateCancelledAppointmentDetails(updatedData, sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("cancel");
    if (!sheet) {
      return { success: false, message: "Sheet not found." };
    }

    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    let rowIndex = -1;

    // Find the appointment row
    for (let i = 1; i < data.length; i++) {
      if (data[i][0].toString() === updatedData.appointmentId) {
        rowIndex = i;
        break;
      }
    }

    if (rowIndex === -1) {
      return { success: false, message: "Appointment not found." };
    }

    // Get column indices for the fields to update (excluding remarks - handled separately)
    const typeCol = headers.indexOf("AppointmentType");
    const doctorCol = headers.indexOf("Doctor");
    const planCol = headers.indexOf("PlanOfAction");

    // Update the values in the sheet (remarks are handled via addRemark RPC)
    if (typeCol !== -1)
      sheet.getRange(rowIndex + 1, typeCol + 1).setValue(updatedData.type);
    if (doctorCol !== -1)
      sheet.getRange(rowIndex + 1, doctorCol + 1).setValue(updatedData.doctor);
    if (planCol !== -1)
      sheet.getRange(rowIndex + 1, planCol + 1).setValue(updatedData.plan);

    // Handle remarks separately if provided (add to history)
    if (updatedData.remarks && updatedData.remarks.trim() !== "") {
      addRemarkToHistory(
        updatedData.appointmentId,
        updatedData.remarks.trim(),
        sessionToken,
      );
    }

    // Update callback date if provided
    if (updatedData.callbackDate !== undefined) {
      const callbackDateValue = updatedData.callbackDate
        ? new Date(updatedData.callbackDate)
        : "";
      sheet.getRange(rowIndex + 1, 35).setValue(callbackDateValue); // Column AI (35th column)
    }

    logAuditEvent(sessionToken, "UPDATE_CANCELLED_APPOINTMENT", "CANCELLED_APPOINTMENT", updatedData.appointmentId, { type: updatedData.type, doctor: updatedData.doctor, plan: updatedData.plan, sheetName: "cancel" });

    return {
      success: true,
      message: "Cancelled appointment details updated successfully.",
    };
  } catch (e) {
    return {
      success: false,
      message:
        "An error occurred while updating cancelled appointment details: " +
        e.toString(),
    };
  }
}

/**
 * Update only the callback date for a cancelled appointment
 * @param {Object} updatedData - Updated appointment data with callback date
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Update status
 */
function updateCancelledAppointmentCallbackDate(updatedData, sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("cancel");
    if (!sheet) {
      return { success: false, message: "Sheet not found." };
    }

    const data = sheet.getDataRange().getValues();
    let rowIndex = -1;

    // Find the appointment row
    for (let i = 1; i < data.length; i++) {
      if (data[i][0].toString() === updatedData.appointmentId) {
        rowIndex = i;
        break;
      }
    }

    if (rowIndex === -1) {
      return { success: false, message: "Appointment not found." };
    }

    // Update callback date in column AI (35th column)
    const callbackDateValue = updatedData.callbackDate
      ? new Date(updatedData.callbackDate)
      : "";
    sheet.getRange(rowIndex + 1, 35).setValue(callbackDateValue);

    logAuditEvent(sessionToken, "UPDATE_CALLBACK_DATE", "CANCELLED_APPOINTMENT", updatedData.appointmentId, { callbackDate: updatedData.callbackDate || "", sheetName: "cancel" });

    return { success: true, message: "Callback date updated successfully." };
  } catch (e) {
    return {
      success: false,
      message:
        "An error occurred while updating callback date: " + e.toString(),
    };
  }
}

/**
 * Restore a cancelled appointment back to the appointment sheet
 * @param {string} appointmentId - ID of the appointment to restore
 * @param {Object} updatedData - Updated appointment data
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Restore status
 */
function restoreCancelledAppointment(rescheduleData) {
  try {
    // Validate appointment data format
    const validationData = {
      appointmentDate: rescheduleData.newDate,
      timeSlot: rescheduleData.newTimeSlot,
      appointmentType: rescheduleData.appointmentType,
    };

    const validation = validateAppointmentData(validationData);
    if (!validation.valid) {
      return {
        success: false,
        message: "Validation failed: " + validation.errors.join("; "),
      };
    }

    // Normalize date and time formats
    try {
      rescheduleData.newDate = normalizeAppointmentDate(rescheduleData.newDate);

      // Only normalize time slot if not WAITING LIST
      if (
        rescheduleData.appointmentType !== "WAITING LIST" &&
        rescheduleData.newTimeSlot
      ) {
        rescheduleData.newTimeSlot = normalizeTimeSlot(
          rescheduleData.newTimeSlot,
        );
      }
    } catch (normalizationError) {
      return {
        success: false,
        message: "Failed to normalize date/time: " + normalizationError.message,
      };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const cancelSheet = ss.getSheetByName("cancel");
    const appointmentSheet = ss.getSheetByName("appointment");

    if (!cancelSheet || !appointmentSheet) {
      return { success: false, message: "Required sheets not found." };
    }

    const data = cancelSheet.getDataRange().getValues();
    const headers = data[0];
    let rowIndex = -1;

    // Find the appointment row
    for (let i = 1; i < data.length; i++) {
      if (data[i][0].toString() === rescheduleData.appointmentId) {
        rowIndex = i;
        break;
      }
    }

    if (rowIndex === -1) {
      return {
        success: false,
        message: "Appointment not found in cancelled list.",
      };
    }

    // Get the row data (create a copy to avoid modifying original)
    const rowData = [...data[rowIndex]];

    // Update the row with new data (excluding Remarks - handled separately via history)
    const updateMap = {
      AppointmentDate: rescheduleData.newDate,
      TimeSlot: rescheduleData.newTimeSlot,
      AppointmentType: rescheduleData.appointmentType,
      Doctor: rescheduleData.doctor,
      PlanOfAction: rescheduleData.newPlanOfAction,
    };

    // Update the values
    Object.entries(updateMap).forEach(([header, value]) => {
      const colIndex = headers.indexOf(header);
      if (colIndex !== -1) {
        rowData[colIndex] = value;
      }
    });

    // Add new remark to history if provided (before moving to appointment sheet)
    if (rescheduleData.newRemarks && rescheduleData.newRemarks.trim() !== "") {
      addRemarkToHistory(
        rescheduleData.appointmentId,
        rescheduleData.newRemarks.trim(),
        rescheduleData.sessionToken,
      );
      // Update rowData's Remarks column with the latest remark so it's preserved when moved
      const remarksCol = headers.indexOf("Remarks");
      if (remarksCol !== -1) {
        rowData[remarksCol] = rescheduleData.newRemarks.trim();
      }
    }

    // Set columns O, P, Q, R, Z, AB, AC, AH to null when moving to appointment sheet
    // Ensure the array is long enough to accommodate these indices (up to AH = index 33)
    while (rowData.length < 34) {
      rowData.push("");
    }

    rowData[14] = ""; // Column O
    rowData[15] = ""; // Column P
    rowData[16] = ""; // Column Q
    rowData[17] = ""; // Column R
    rowData[25] = ""; // Column Z
    rowData[27] = ""; // Column AB
    rowData[28] = ""; // Column AC
    rowData[33] = ""; // Column AH

    // Add to reschedule history
    const historyCol = headers.indexOf("RescheduleHistory");
    if (historyCol !== -1) {
      const history = rowData[historyCol]
        ? JSON.parse(rowData[historyCol])
        : [];

      // Get the original appointment date and time before updating
      const originalDate = rowData[headers.indexOf("AppointmentDate")];
      const originalTime = rowData[headers.indexOf("TimeSlot")];

      history.push({
        timestamp: new Date(),
        action: "restored",
        by: getSessionUsername(rescheduleData.sessionToken),
        fromDate: originalDate,
        toDate: rescheduleData.newDate,
        fromTime: originalTime,
        toTime: rescheduleData.newTimeSlot,
      });
      rowData[historyCol] = JSON.stringify(history);
    } else {
    }

    // ✅ ETERNAL TRACKING: Get existing journey from cancel sheet BEFORE moving
    const cancelJourneyColIndex = headers.indexOf("AppointmentJourney");
    let existingJourney = [];

    if (cancelJourneyColIndex !== -1 && rowData[cancelJourneyColIndex]) {
      try {
        existingJourney = JSON.parse(rowData[cancelJourneyColIndex]);
      } catch (e) {
        existingJourney = [];
      }
    }

    // Format dates and times consistently
    const originalDate = rowData[headers.indexOf("AppointmentDate")];
    const originalTime = rowData[headers.indexOf("TimeSlot")];
    const fromDateFormatted = Utilities.formatDate(
      new Date(originalDate),
      Session.getScriptTimeZone(),
      "yyyy-MM-dd",
    );
    const fromTimeFormatted =
      typeof originalTime === "object" && originalTime instanceof Date
        ? Utilities.formatDate(
            originalTime,
            Session.getScriptTimeZone(),
            "HH:mm",
          )
        : originalTime || "";

    // Add restore journey entry
    existingJourney.push({
      timestamp: new Date().toISOString(),
      action: "restored",
      by: getSessionUsername(rescheduleData.sessionToken),
      fromSheet: "cancel",
      toSheet: "appointment",
      fromDate: fromDateFormatted,
      toDate: rescheduleData.newDate,
      fromTime: fromTimeFormatted,
      toTime: rescheduleData.newTimeSlot,
      description: "Appointment restored from cancelled list and rescheduled",
    });

    // Ensure appointment sheet has journey column
    const appointmentJourneyColIndex = ensureJourneyColumn(appointmentSheet);

    // Ensure rowData has enough columns for journey
    while (rowData.length < Math.max(appointmentSheet.getLastColumn(), 36)) {
      rowData.push("");
    }

    // Copy journey data to restored appointment row
    if (appointmentJourneyColIndex !== -1) {
      rowData[appointmentJourneyColIndex] = JSON.stringify(existingJourney);
    }

    // Move to appointment sheet
    appointmentSheet.appendRow(rowData);

    // Delete from cancel sheet
    cancelSheet.deleteRow(rowIndex + 1);

    // Ensure appointment sheet's Remarks column is updated with latest remark after move
    if (rescheduleData.newRemarks && rescheduleData.newRemarks.trim() !== "") {
      updateAppointmentLatestRemark(
        rescheduleData.appointmentId,
        rescheduleData.newRemarks.trim(),
      );
    }

    // Log audit event
    logAuditEvent(
      rescheduleData.sessionToken,
      "RESTORE_CANCELLED_APPOINTMENT",
      "CANCELLED_APPOINTMENT",
      rescheduleData.appointmentId,
      {
        sheetName: "cancel",
        movedToSheet: "appointment",
        newAppointmentDate: rescheduleData.newDate,
        newTimeSlot: rescheduleData.newTimeSlot,
        patientName: rowData[4] || "",
        mrdNo: rowData[3] || "",
        restoredBy: getSessionUsername(rescheduleData.sessionToken),
      },
    );

    return { success: true, message: "Appointment restored successfully." };
  } catch (e) {
    return {
      success: false,
      message: "An error occurred while restoring appointment: " + e.toString(),
    };
  }
}

/**
 * Archive a cancelled appointment to the archive sheet
 * @param {string} appointmentId - ID of the appointment to archive
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Archive status
 */
function archiveCancelledAppointment(appointmentId, sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const cancelSheet = ss.getSheetByName("cancel");
    const archiveSheet = ss.getSheetByName("Archive");

    if (!cancelSheet || !archiveSheet) {
      return { success: false, message: "Required sheets not found." };
    }

    // Ensure journey column exists in both sheets
    const cancelJourneyColIndex = ensureJourneyColumn(cancelSheet);
    const archiveJourneyColIndex = ensureJourneyColumn(archiveSheet);

    // Get the full data range to ensure all columns are included
    const lastRow = cancelSheet.getLastRow();
    const lastCol = cancelSheet.getLastColumn();

    if (lastRow === 0 || lastCol === 0) {
      return { success: false, message: "Cancel sheet is empty." };
    }

    const data = cancelSheet.getRange(1, 1, lastRow, lastCol).getValues();
    const headers = data[0];
    let rowIndex = -1;

    // Find the appointment row
    for (let i = 1; i < data.length; i++) {
      if (data[i][0].toString() === appointmentId) {
        rowIndex = i;
        break;
      }
    }

    if (rowIndex === -1) {
      return {
        success: false,
        message: "Appointment not found in cancelled list.",
      };
    }

    // Get the complete row data (ensuring all columns including V and W)
    const rowData = [...data[rowIndex]]; // Create a copy of the array

    // Add to reschedule history (legacy support)
    const historyCol = headers.indexOf("RescheduleHistory");
    if (historyCol !== -1) {
      const history = rowData[historyCol]
        ? JSON.parse(rowData[historyCol])
        : [];
      history.push({
        timestamp: new Date(),
        action: "archived",
        by: getSessionUsername(sessionToken),
      });
      rowData[historyCol] = JSON.stringify(history);
    }

    // Get existing journey and add archive entry
    let journey = [];
    if (cancelJourneyColIndex !== -1 && rowData[cancelJourneyColIndex]) {
      try {
        journey = JSON.parse(rowData[cancelJourneyColIndex]);
      } catch (e) {
        journey = [];
      }
    }

    // Add "archived" journey entry
    journey.push({
      timestamp: new Date().toISOString(),
      action: "archived",
      by: getSessionUsername(sessionToken),
      fromSheet: "cancel",
      toSheet: "Archive",
      description: "Archived from cancelled appointments list",
    });

    // Ensure Archive sheet has proper headers including the new archive columns
    const archiveLastCol = archiveSheet.getLastColumn();
    const requiredColumns = Math.max(lastCol, 36); // Ensure we have at least 36 columns (up to column AJ)

    if (archiveLastCol < requiredColumns) {
      // Extend the header row with missing headers
      const archiveHeaders =
        archiveSheet
          .getRange(1, 1, 1, Math.min(archiveLastCol, 1))
          .getValues()[0] || [];
      const extendedHeaders = [...headers]; // Copy original headers

      // Ensure we have headers for columns X, Y, and AJ
      while (extendedHeaders.length < 23) extendedHeaders.push(""); // Fill up to column W
      if (extendedHeaders.length === 23) extendedHeaders.push("ArchivedDate"); // Column X
      if (extendedHeaders.length === 24) extendedHeaders.push("ArchivedBy"); // Column Y
      while (extendedHeaders.length < 35) extendedHeaders.push(""); // Fill up to column AI
      if (extendedHeaders.length === 35)
        extendedHeaders.push("AppointmentJourney"); // Column AJ

      // Set the complete header row
      archiveSheet
        .getRange(1, 1, 1, extendedHeaders.length)
        .setValues([extendedHeaders]);
    }

    // Extend rowData to include archived date, archived by, and journey
    // Ensure we have at least 36 columns (up to column AJ)
    while (rowData.length < 36) {
      rowData.push(""); // Fill empty columns
    }

    // Set Column X (index 23) - Archived Date
    rowData[23] = new Date();

    // Set Column Y (index 24) - Archived By
    rowData[24] = getSessionUsername(sessionToken);

    // Set Column AJ (index 35) - AppointmentJourney
    rowData[35] = JSON.stringify(journey);

    // Retrieve and consolidate all remarks from history before archiving
    const consolidatedRemarks = consolidateRemarks(appointmentId);

    // Update Remarks column (L) with consolidated remarks
    const remarksCol = headers.indexOf("Remarks");
    if (remarksCol !== -1) {
      // If there are existing remarks, append consolidated ones; otherwise use consolidated
      const existingRemarks = rowData[remarksCol]
        ? rowData[remarksCol].toString().trim()
        : "";
      if (existingRemarks && consolidatedRemarks) {
        rowData[remarksCol] = existingRemarks + " | " + consolidatedRemarks;
      } else if (consolidatedRemarks) {
        rowData[remarksCol] = consolidatedRemarks;
      }
      // If no consolidated remarks, keep existing (if any)
    }

    // Ensure tags are preserved in column AF (index 31)
    const TAG_COLUMN_INDEX = 31;
    const tagString = data[rowIndex][TAG_COLUMN_INDEX] || "";
    if (tagString && tagString.trim() !== "") {
      // Ensure rowData has the tag data
      rowData[TAG_COLUMN_INDEX] = tagString;
    }

    // Log the final data being added for debugging

    // Move to archive sheet - ensure all columns are transferred
    archiveSheet.appendRow(rowData);

    // Delete from cancel sheet (only after successful append)
    cancelSheet.deleteRow(rowIndex + 1);

    // Verify tags were migrated successfully (reuse tagString from above)
    if (tagString && tagString.trim() !== "") {
      const verifyResult = getAppointmentTags(appointmentId, "Archive");
      if (verifyResult.success && verifyResult.tags.length > 0) {
      } else {
      }
    }

    // Delete remarks from history only after successful archive
    if (consolidatedRemarks) {
      deleteRemarksFromHistory(appointmentId);
    }

    // Log audit event
    logAuditEvent(
      sessionToken,
      "ARCHIVE_CANCELLED_APPOINTMENT",
      "CANCELLED_APPOINTMENT",
      appointmentId,
      {
        sheetName: "cancel",
        movedToSheet: "Archive",
        patientName: rowData[4] || "",
        mrdNo: rowData[3] || "",
        archivedBy: getSessionUsername(sessionToken),
        originalCancelDate: rowData[1] || "",
      },
    );

    return {
      success: true,
      message:
        "Appointment archived successfully with complete journey tracking.",
    };
  } catch (e) {
    return {
      success: false,
      message: "An error occurred while archiving appointment: " + e.toString(),
    };
  }
}

// Add this function to check if a slot is fixed
function isSlotFixed(doctor, dateString, timeSlot) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("appointment");
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      const rowDate = Utilities.formatDate(
        new Date(data[i][1]),
        Session.getScriptTimeZone(),
        "yyyy-MM-dd",
      );
      const rowTime = Utilities.formatDate(
        new Date(data[i][2]),
        Session.getScriptTimeZone(),
        "HH:mm",
      );
      const rowDoctor = data[i][9];
      const isFixed = data[i][25]; // Column Z (0-based index)

      if (
        rowDate === dateString &&
        rowTime === timeSlot &&
        rowDoctor === doctor &&
        isFixed === "Yes"
      ) {
        return true;
      }
    }
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * Check if the user has access to the Patient Master page (Level 1, 2, or 3)
 * @param {string} sessionToken - The session token to check
 * @return {boolean} True if the user has access (Level 1, 2, or 3)
 */
function hasAccessToPatientMaster(sessionToken) {
  return canUpdatePatientDetails(sessionToken);
}

/**
 * Get patient type options from generalSettings sheet
 * @return {Object} Object containing success status and patient type options
 */
function getPatientTypeOptions() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("generalSettings");

    if (!sheet) {
      return {
        success: false,
        message: "generalSettings sheet not found",
      };
    }

    // Get values from column B (skip header row)
    const data = sheet.getRange("B2:B100").getValues();
    const typeOptions = [];

    // Process each row and add non-empty values to the options array
    for (let i = 0; i < data.length; i++) {
      const value = data[i][0];
      if (value && typeof value === "string" && value.trim() !== "") {
        typeOptions.push(value.trim());
      }
    }

    return {
      success: true,
      typeOptions: typeOptions,
    };
  } catch (error) {
    return {
      success: false,
      message: "Error retrieving patient type options: " + error.toString(),
    };
  }
}

/**
 * Returns the URL for the Dashboard page
 * This function helps with proper navigation between pages
 * @param {string} sessionToken - The session token to include in the URL
 * @return {string} The fully formed URL to the dashboard page
 */
function getDashboardUrl(sessionToken) {
  try {
    // Validate the session first
    const session = getUserSession(sessionToken);
    if (!session) {
      // If session is invalid, return URL to login page
      return ScriptApp.getService().getUrl();
    }

    // Construct the proper URL
    const baseUrl = ScriptApp.getService().getUrl();
    const dashboardUrl =
      baseUrl +
      "?page=Dashboard&sessionToken=" +
      encodeURIComponent(sessionToken);

    return dashboardUrl;
  } catch (error) {
    return ScriptApp.getService().getUrl(); // Return base URL as fallback
  }
}

function getPlanOfActionOptions() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    // ← Use your actual sheet name here
    const sheet = ss.getSheetByName("PlanOfActionMaster");
    if (!sheet)
      return { success: false, message: "PlanOfActionMaster sheet not found" };
    const data = sheet.getDataRange().getValues();
    const options = data
      .slice(1)
      .filter((r) => r[0])
      .map((r) => ({
        name: r[0].toString().trim(),
        requiresEyeSelection: String(r[1]).toLowerCase() === "yes",
      }));
    return { success: true, options };
  } catch (error) {
    return { success: false, message: error.toString() };
  }
}

/**
 * Deletes an appointment by ID
 * @param {string} appointmentId - The ID of the appointment to delete
 * @param {string} sessionToken - The session token for authentication
 * @return {Object} Status object indicating success or failure
 */
function deleteAppointment(appointmentId, sessionToken) {
  try {
    // Validate session
    const session = getUserSession(sessionToken);
    if (!session || !session.username) {
      return { success: false, message: "Not authorized: Invalid session" };
    }

    // Get the spreadsheet - using getActive() instead of openById
    const ss = SpreadsheetApp.getActive();

    // List all sheets for debugging
    const allSheets = ss.getSheets();
    const sheetNames = allSheets.map((sheet) => sheet.getName());

    const appointmentsSheet = ss.getSheetByName("Appointments");

    if (!appointmentsSheet) {
      // Try alternative sheet names
      const possibleSheetNames = [
        "appointments",
        "APPOINTMENTS",
        "AppointmentsData",
        "appointment",
        "Appointment",
      ];

      for (const sheetName of possibleSheetNames) {
        const altSheet = ss.getSheetByName(sheetName);
        if (altSheet) {
          // Use this sheet instead
          return deleteAppointmentFromSheet(appointmentId, altSheet, session);
        }
      }

      return { success: false, message: "Error: Appointments sheet not found" };
    }

    return deleteAppointmentFromSheet(
      appointmentId,
      appointmentsSheet,
      session,
    );
  } catch (error) {
    return { success: false, message: `Error: ${error.toString()}` };
  }
}

/**
 * Helper function to delete an appointment from a specific sheet
 * @param {string} appointmentId - The ID of the appointment to delete
 * @param {Sheet} appointmentsSheet - The sheet containing the appointment data
 * @param {Object} session - The user session object
 * @return {Object} Status object indicating success or failure
 */
function deleteAppointmentFromSheet(appointmentId, appointmentsSheet, session) {
  try {
    const ss = SpreadsheetApp.getActive();

    // Get all data
    const data = appointmentsSheet.getDataRange().getValues();
    const headers = data[0];

    const idColIndex = headers.indexOf("AppointmentID");

    if (idColIndex === -1) {
      return {
        success: false,
        message: "Error: AppointmentID column not found",
      };
    }

    // Find the appointment row
    let rowIndex = -1;
    let rowData = null;
    for (let i = 1; i < data.length; i++) {
      if (data[i][idColIndex] == appointmentId) {
        rowIndex = i + 1; // +1 because array is 0-indexed but sheet is 1-indexed
        rowData = [...data[i]]; // Clone the row data
        break;
      }
    }

    if (rowIndex === -1) {
      return { success: false, message: "Appointment not found" };
    }

    // ⚠️ CRITICAL CHANGE: DELETE → ARCHIVE (NOT permanent deletion!)
    const archiveSheet = ss.getSheetByName("Archive");

    if (!archiveSheet) {
      return {
        success: false,
        message: "Archive sheet not found. Cannot delete appointment safely.",
      };
    }

    // Ensure journey column exists in source and Archive sheets
    const sourceJourneyColIndex = ensureJourneyColumn(appointmentsSheet);
    const archiveJourneyColIndex = ensureJourneyColumn(archiveSheet);

    // Get existing journey from the appointment
    let journey = [];
    if (sourceJourneyColIndex !== -1 && rowData[sourceJourneyColIndex]) {
      try {
        journey = JSON.parse(rowData[sourceJourneyColIndex]);
      } catch (e) {
        journey = [];
      }
    }

    // Add "deleted" journey entry
    journey.push({
      timestamp: new Date().toISOString(),
      action: "deleted",
      by: session.username,
      fromSheet: appointmentsSheet.getName(),
      toSheet: "Archive",
      description: "Deleted and moved to Archive for eternal tracking",
      reason: "User requested deletion",
    });

    // Ensure rowData has enough columns for Archive sheet
    const archiveHeaders = archiveSheet
      .getRange(1, 1, 1, archiveSheet.getLastColumn())
      .getValues()[0];
    while (rowData.length < archiveHeaders.length) {
      rowData.push("");
    }

    // Update journey in rowData
    if (archiveJourneyColIndex !== -1) {
      rowData[archiveJourneyColIndex] = JSON.stringify(journey);
    }

    // Add deletion metadata (Column V - DeletedOn, Column W - DeletedBy)
    const deletedOnColIndex = archiveHeaders.indexOf("DeletedOn");
    const deletedByColIndex = archiveHeaders.indexOf("DeletedBy");

    if (deletedOnColIndex !== -1) {
      rowData[deletedOnColIndex] = new Date();
    }
    if (deletedByColIndex !== -1) {
      rowData[deletedByColIndex] = session.username;
    }

    // Add archive metadata (Column X - ArchivedDate, Column Y - ArchivedBy)
    const archivedDateColIndex = archiveHeaders.indexOf("ArchivedDate");
    const archivedByColIndex = archiveHeaders.indexOf("ArchivedBy");

    if (archivedDateColIndex !== -1) {
      rowData[archivedDateColIndex] = new Date();
    }
    if (archivedByColIndex !== -1) {
      rowData[archivedByColIndex] = session.username;
    }

    // Move to Archive sheet
    archiveSheet.appendRow(rowData);

    // Remove from source sheet (only after safe archival)
    appointmentsSheet.deleteRow(rowIndex);

    return {
      success: true,
      message: "Appointment deleted successfully (moved to Archive)",
      deletedBy: session.username,
      deleteDate: new Date(),
      archivedSafely: true,
    };
  } catch (error) {
    return { success: false, message: `Error: ${error.toString()}` };
  }
}

function getBlockedSlotsCount(doctor, dateString) {
  try {
    let blockedSlots = 0;

    // Get disallowed intervals for general appointments
    const disallowed = getDisallowedIntervals();
    disallowed.forEach(function (interval) {
      if (
        interval.day === "D" ||
        interval.day === getDayCode(new Date(dateString))
      ) {
        const startMins = timeStringToMinutes(interval.startTime);
        const endMins = timeStringToMinutes(interval.endTime);

        if (!isNaN(startMins) && !isNaN(endMins) && endMins > startMins) {
          // Get booked slots for this time range
          const bookedSlots = getBookedSlots(doctor, dateString);
          const bookedSlotsInRange = bookedSlots.filter((slot) => {
            const slotMins = timeStringToMinutes(slot);
            return slotMins >= startMins && slotMins < endMins;
          });

          // Calculate total possible slots in this range
          const totalSlotsInRange = Math.floor((endMins - startMins) / 10);
          // Add only the unfilled slots to blocked count
          blockedSlots += totalSlotsInRange - bookedSlotsInRange.length;
        }
      }
    });

    // Get specialized intervals for Urgent New and Emergency
    const urgentNewIntervals = getSpecializedIntervals("URGENT NEW");
    const emergencyIntervals = getSpecializedIntervals("EMERGENCY");

    // Calculate blocked slots for Urgent New
    urgentNewIntervals.forEach(function (interval) {
      if (
        interval.day === "D" ||
        interval.day === getDayCode(new Date(dateString))
      ) {
        const startMins = timeStringToMinutes(interval.startTime);
        const endMins = timeStringToMinutes(interval.endTime);

        if (!isNaN(startMins) && !isNaN(endMins) && endMins > startMins) {
          // Get booked slots for this time range
          const bookedSlots = getBookedSlots(doctor, dateString);
          const bookedSlotsInRange = bookedSlots.filter((slot) => {
            const slotMins = timeStringToMinutes(slot);
            return slotMins >= startMins && slotMins < endMins;
          });

          // Calculate total possible slots in this range
          const totalSlotsInRange = Math.floor((endMins - startMins) / 10);
          // Add only the unfilled slots to blocked count
          blockedSlots += totalSlotsInRange - bookedSlotsInRange.length;
        }
      }
    });

    // Calculate blocked slots for Emergency
    emergencyIntervals.forEach(function (interval) {
      if (
        interval.day === "D" ||
        interval.day === getDayCode(new Date(dateString))
      ) {
        const startMins = timeStringToMinutes(interval.startTime);
        const endMins = timeStringToMinutes(interval.endTime);

        if (!isNaN(startMins) && !isNaN(endMins) && endMins > startMins) {
          // Get booked slots for this time range
          const bookedSlots = getBookedSlots(doctor, dateString);
          const bookedSlotsInRange = bookedSlots.filter((slot) => {
            const slotMins = timeStringToMinutes(slot);
            return slotMins >= startMins && slotMins < endMins;
          });

          // Calculate total possible slots in this range
          const totalSlotsInRange = Math.floor((endMins - startMins) / 10);
          // Add only the unfilled slots to blocked count
          blockedSlots += totalSlotsInRange - bookedSlotsInRange.length;
        }
      }
    });

    return blockedSlots;
  } catch (error) {
    return 0;
  }
}

function sendEmailOverview() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentsSheet = ss.getSheetByName("appointment");
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get all appointments for today
    const data = appointmentsSheet.getDataRange().getValues();
    const todayAppointments = [];
    const planOfActionCounts = {};

    for (let i = 1; i < data.length; i++) {
      const appointmentDate = new Date(data[i][1]);
      appointmentDate.setHours(0, 0, 0, 0);

      if (appointmentDate.getTime() === today.getTime()) {
        todayAppointments.push(data[i]);
        const planOfAction = data[i][3] || "No Plan"; // Column D is Plan of Action
        planOfActionCounts[planOfAction] =
          (planOfActionCounts[planOfAction] || 0) + 1;
      }
    }

    // Get available slots count
    const availableSlots = getAvailableSlotsCount();

    // Get blocked slots count for each doctor
    const doctors = getDoctors();
    let totalBlockedSlots = 0;

    doctors.forEach(function (doctor) {
      const blockedSlots = getBlockedSlotsCount(
        doctor.name,
        Utilities.formatDate(today, Session.getScriptTimeZone(), "yyyy-MM-dd"),
      );
      totalBlockedSlots += blockedSlots;
    });

    // Create email body
    let emailBody =
      "Appointment Overview for " +
      Utilities.formatDate(today, Session.getScriptTimeZone(), "dd/MM/yyyy") +
      "\n\n";

    // Add Plan of Action breakdown
    emailBody += "Plan of Action Breakdown:\n";
    for (const [plan, count] of Object.entries(planOfActionCounts)) {
      emailBody += `${plan}: ${count}\n`;
    }

    // Add slot information
    emailBody += "\nSlot Information:\n";
    emailBody += `Total Available Slots: ${availableSlots.count}\n`;
    emailBody += `Total Blocked Slots: ${totalBlockedSlots}\n`;

    // Add appointment details
    emailBody += "\nAppointment Details:\n";
    todayAppointments.forEach(function (appointment) {
      emailBody += `Time: ${appointment[2]}, Patient: ${appointment[4]}, Plan: ${appointment[3] || "No Plan"}\n`;
    });

    // Send email
    const emailAddress = Session.getActiveUser().getEmail();
    MailApp.sendEmail({
      to: emailAddress,
      subject:
        "Appointment Overview - " +
        Utilities.formatDate(today, Session.getScriptTimeZone(), "dd/MM/yyyy"),
      body: emailBody,
    });

    return { success: true };
  } catch (error) {
    return { success: false, error: error.toString() };
  }
}

function getWaitingListDistribution() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentsSheet = ss.getSheetByName("appointment");
    const data = appointmentsSheet.getDataRange().getValues();

    // Log header row to verify column indices

    // Initialize counters
    const distribution = {
      red: 0,
      yellow: 0,
      green: 0,
    };

    // Skip header row
    for (let i = 1; i < data.length; i++) {
      const row = data[i];

      // Check if it's a waiting list appointment
      const appointmentType = row[8]?.toString().trim().toUpperCase() || ""; // Column I (index 8) is AppointmentType

      if (appointmentType === "WAITING LIST") {
        const urgencyLevel = row[27]?.toString().trim().toLowerCase() || ""; // Last column (index 27) is Urgency Level

        switch (urgencyLevel) {
          case "red":
            distribution.red++;
            break;
          case "yellow":
            distribution.yellow++;
            break;
          case "green":
            distribution.green++;
            break;
          default:
        }
      }
    }

    return distribution;
  } catch (error) {
    return { red: 0, yellow: 0, green: 0 };
  }
}
/**
 * 1) Copy appointments for the given date into slotOptimization sheet
 * 2) Call the heap-based scheduler to fill results sheets
 */
function runSlotOptimizationForDate(dateStr) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var src = ss.getSheetByName("appointment");
  var dest = ss.getSheetByName("slotOptimization");
  if (!src || !dest)
    throw new Error("appointment or slotOptimization sheet missing");
  // Clear and set headers
  dest.clearContents();
  dest.appendRow([
    "Date",
    "TimeSlot",
    "MRD No",
    "Patient Name",
    "Age",
    "Gender",
    "Mobile",
    "Procedures",
    "Fixed",
    "Family Group",
  ]);

  var selected = new Date(dateStr);
  selected.setHours(0, 0, 0, 0);
  var all = src.getDataRange().getValues();
  // Copy matching rows
  for (var i = 1; i < all.length; i++) {
    var r = all[i],
      d = new Date(r[1]);
    d.setHours(0, 0, 0, 0);
    if (d.getTime() === selected.getTime()) {
      dest.appendRow([
        dateStr,
        r[2],
        r[3],
        r[4],
        r[5],
        r[6],
        r[7],
        r[10],
        r[25],
        r[28],
      ]);
    }
  }
  // Run scheduler (populates Optimized Schedule, Availability Blocks, etc.)
  return generateOptimizedSchedules();
}

/**
 * Return all values from the named sheet as a 2D array of strings.
 */
function getSheetData(sheetName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error("Sheet not found: " + sheetName);
  return sheet.getDataRange().getDisplayValues();
}

/**
 * Calculate total consultation time (in minutes) for a given date
 */
function calculateTotalConsultationTime(dateString) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentsSheet = ss.getSheetByName("appointment");
    const planOfActionSheet = ss.getSheetByName("PlanOfActionMaster");

    if (!appointmentsSheet || !planOfActionSheet) {
      throw new Error("Required sheets not found");
    }

    // Load PlanOfActionMaster data
    const planData = planOfActionSheet.getDataRange().getDisplayValues();
    const planHeaders = planData[0];
    const procedureData = new Map();

    // Create map of procedure to duration
    const procCol = planHeaders.indexOf("Plan of action");
    const consultCol = planHeaders.indexOf("ConsultMin");

    for (let i = 1; i < planData.length; i++) {
      const row = planData[i];
      const procedure = row[procCol];
      if (!procedure) continue;
      procedureData.set(procedure, parseInt(row[consultCol], 10) || 10); // Default 10 mins if not specified
    }

    // Get appointments for the date
    const appointments = appointmentsSheet.getDataRange().getDisplayValues();
    let totalConsultTime = 0;

    for (let i = 1; i < appointments.length; i++) {
      const row = appointments[i];
      const apptDate = Utilities.formatDate(
        new Date(row[1]),
        Session.getScriptTimeZone(),
        "yyyy-MM-dd",
      );

      if (apptDate === dateString) {
        let procedures = [];

        // Parse Plan of Action from column K (index 10)
        if (row[10]) {
          try {
            // Try to parse as JSON array first
            const planOfActionStr = row[10].toString().trim();
            if (
              planOfActionStr.startsWith("[") &&
              planOfActionStr.endsWith("]")
            ) {
              procedures = JSON.parse(planOfActionStr);
            } else {
              // Fallback to comma-separated string
              procedures = planOfActionStr.split(",").map((p) => p.trim());
            }
          } catch (parseError) {
            // Fallback to string splitting
            procedures = row[10]
              .toString()
              .split(",")
              .map((p) => p.trim());
          }
        }

        let maxDuration = 0;

        // Process each procedure
        procedures.forEach((proc) => {
          if (!proc) return;

          // Clean up the procedure string by removing side labels like (RE), (LE), (BE)
          const cleanProc = proc
            .toString()
            .replace(/\s*\(.*?\)\s*/g, "") // Remove anything in parentheses
            .replace(/^["']|["']$/g, "") // Remove leading/trailing quotes
            .trim();

          if (cleanProc) {
            const duration = procedureData.get(cleanProc) || 10; // Default 10 mins if not found
            maxDuration = Math.max(maxDuration, duration);
          }
        });

        totalConsultTime += maxDuration;
      }
    }

    return totalConsultTime;
  } catch (e) {
    return 0;
  }
}

/**
 * Calculate total available minutes for a doctor on a given date
 */
function calculateTotalAvailableMinutes(doctor, dateString) {
  try {
    // Get default availability for the day
    const dayOfWeek = new Date(dateString).toLocaleDateString("en-US", {
      weekday: "long",
    });
    const availabilityRanges = getDoctorAvailabilityRanges(doctor, dayOfWeek);

    let totalMinutes = 0;
    availabilityRanges.forEach((range) => {
      const [startTime, endTime] = range.split("-");
      if (startTime && endTime) {
        const startMins = timeStringToMinutes(startTime.trim());
        const endMins = timeStringToMinutes(endTime.trim());
        if (endMins > startMins) {
          totalMinutes += endMins - startMins;
        }
      }
    });

    // Subtract exception ranges
    const exceptions = getDoctorExceptionRanges(doctor, dateString);
    exceptions.forEach((range) => {
      const [startTime, endTime] = range.split("-");
      if (startTime && endTime) {
        const startMins = timeStringToMinutes(startTime.trim());
        const endMins = timeStringToMinutes(endTime.trim());
        if (endMins > startMins) {
          totalMinutes -= endMins - startMins;
        }
      }
    });

    // Subtract lunch break (30 minutes)
    totalMinutes -= 30;

    return Math.max(0, totalMinutes);
  } catch (e) {
    return 0;
  }
}

/**
 * Calculate load for a specific day
 */
function calculateDayLoad(dateString) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentsSheet = ss.getSheetByName("appointment");
    const doctorsSheet = ss.getSheetByName("DoctorAvailability");

    if (!appointmentsSheet || !doctorsSheet) {
      throw new Error("Required sheets not found");
    }

    // Get all doctors
    const doctorsData = doctorsSheet.getDataRange().getDisplayValues();
    const doctors = doctorsData.slice(1).map((row) => row[0]); // First column contains doctor names

    // Calculate total consultation time once for all appointments (not per doctor)
    const totalConsultTime = calculateTotalConsultationTime(dateString);

    let totalAvailableMinutes = 0;

    // Calculate total available minutes for all doctors
    doctors.forEach((doctor) => {
      totalAvailableMinutes += calculateTotalAvailableMinutes(
        doctor,
        dateString,
      );
    });

    return {
      totalConsultTime: totalConsultTime,
      totalAvailableMinutes: totalAvailableMinutes,
    };
  } catch (e) {
    return {
      totalConsultTime: 0,
      totalAvailableMinutes: 0,
    };
  }
}

/**
 * Move one appointment from "appointment" → "Archive" sheet.
 */
function archiveAppointment(appointmentId, sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const src = ss.getSheetByName("appointment");
    const dest = ss.getSheetByName("Archive");

    if (!src || !dest) {
      return {
        success: false,
        message: "Appointment or Archive sheet not found.",
      };
    }

    // Ensure journey column exists in both sheets
    const srcJourneyColIndex = ensureJourneyColumn(src);
    const destJourneyColIndex = ensureJourneyColumn(dest);

    // 1. Read all rows and find the matching appointment
    const data = src.getDataRange().getValues();
    const headers = data[0];
    let rowIdx = -1;

    for (let i = 1; i < data.length; i++) {
      if (data[i][0].toString() === appointmentId) {
        rowIdx = i;
        break;
      }
    }

    if (rowIdx === -1) {
      return { success: false, message: "Appointment not found." };
    }

    // 2. Prepare metadata
    const archiveDate = new Date();
    const archivedBy = getSessionUsername(sessionToken);

    // 3. Get the original row and prepare journey
    const originalRow = [...data[rowIdx]]; // Clone the row

    // Get existing journey
    let journey = [];
    if (srcJourneyColIndex !== -1 && originalRow[srcJourneyColIndex]) {
      try {
        journey = JSON.parse(originalRow[srcJourneyColIndex]);
      } catch (e) {
        journey = [];
      }
    }

    // Add "archived" journey entry BEFORE moving
    journey.push({
      timestamp: new Date().toISOString(),
      action: "archived",
      by: archivedBy,
      fromSheet: "appointment",
      toSheet: "Archive",
      description: "Archived from active appointments",
    });

    // Ensure originalRow has enough columns for Archive sheet
    const destHeaders = dest
      .getRange(1, 1, 1, dest.getLastColumn())
      .getValues()[0];
    while (originalRow.length < Math.max(destHeaders.length, 36)) {
      originalRow.push("");
    }

    // Update journey in the row data
    if (destJourneyColIndex !== -1) {
      originalRow[destJourneyColIndex] = JSON.stringify(journey);
    }

    // Set archive metadata
    // Column X (index 23) - ArchivedDate
    if (destHeaders.indexOf("ArchivedDate") !== -1) {
      originalRow[destHeaders.indexOf("ArchivedDate")] = archiveDate;
    } else {
      originalRow[23] = archiveDate;
    }

    // Column Y (index 24) - ArchivedBy
    if (destHeaders.indexOf("ArchivedBy") !== -1) {
      originalRow[destHeaders.indexOf("ArchivedBy")] = archivedBy;
    } else {
      originalRow[24] = archivedBy;
    }

    // Retrieve and consolidate all remarks from history before archiving
    const consolidatedRemarks = consolidateRemarks(appointmentId);

    // Update Remarks column (L) with consolidated remarks
    const remarksCol = headers.indexOf("Remarks");
    if (remarksCol !== -1) {
      // If there are existing remarks, append consolidated ones; otherwise use consolidated
      const existingRemarks = originalRow[remarksCol]
        ? originalRow[remarksCol].toString().trim()
        : "";
      if (existingRemarks && consolidatedRemarks) {
        originalRow[remarksCol] = existingRemarks + " | " + consolidatedRemarks;
      } else if (consolidatedRemarks) {
        originalRow[remarksCol] = consolidatedRemarks;
      }
      // If no consolidated remarks, keep existing (if any)
    }

    // Ensure tags are preserved in column AF (index 31)
    const TAG_COLUMN_INDEX = 31;
    const tagString = data[rowIdx][TAG_COLUMN_INDEX] || "";
    if (tagString && tagString.trim() !== "") {
      // Ensure originalRow has the tag data
      originalRow[TAG_COLUMN_INDEX] = tagString;
    }

    // 4. Append to Archive with all metadata
    dest.appendRow(originalRow);

    // 5. Remove the row from the source sheet (only after safe archival)
    src.deleteRow(rowIdx + 1);

    // Verify tags were migrated successfully (reuse tagString from above)
    if (tagString && tagString.trim() !== "") {
      const verifyResult = getAppointmentTags(appointmentId, "Archive");
      if (verifyResult.success && verifyResult.tags.length > 0) {
      } else {
      }
    }

    // Delete remarks from history only after successful archive
    if (consolidatedRemarks) {
      deleteRemarksFromHistory(appointmentId);
    }

    // Log audit event for appointment archival
    try {
      logAuditEvent(
        sessionToken,
        "ARCHIVE_APPOINTMENT",
        "APPOINTMENT",
        appointmentId,
        {
          date: data[rowIdx][1], // AppointmentDate - Column B
          time: data[rowIdx][2], // TimeSlot - Column C
          mrdNo: data[rowIdx][3], // MRDNo - Column D
          patientName: data[rowIdx][4], // Name - Column E
          archivedBy: archivedBy,
          sheetName: "Archive",
        },
      );
    } catch (auditError) {
      // Don't fail archival if audit logging fails
      Logger.log(
        "Audit logging failed for appointment archival: " +
          auditError.toString(),
      );
    }

    return {
      success: true,
      message:
        "Appointment archived successfully with complete journey tracking.",
    };
  } catch (e) {
    return {
      success: false,
      message: "Error archiving appointment: " + e.toString(),
    };
  }
}

/**
 * Returns, for the given month (YYYY-MM), a map of
 *   doctor → { dateString → [ "HH:mm-HH:mm", … ] }
 * representing each doctor's exception blocks.
 */
function getDoctorMonthlyExceptionMap(monthKey, filterDoctor) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("DoctorAvailabilityExceptions");
  if (!sheet) return {};

  const data = sheet.getDataRange().getValues();
  const map = {};

  // Skip header row
  for (let i = 1; i < data.length; i++) {
    const [doc, rawDate, fromRaw, toRaw] = data[i];
    const doctor = doc.toString().trim();

    // Filter by doctor if provided
    if (filterDoctor && doctor !== filterDoctor) {
      continue;
    }

    const date = Utilities.formatDate(
      new Date(rawDate),
      Session.getScriptTimeZone(),
      "yyyy-MM-dd",
    );
    // only include this month
    if (!date.startsWith(monthKey)) continue;

    const from = formatTimeString(fromRaw);
    const to = formatTimeString(toRaw);
    if (!from || !to) continue;

    map[doctor] = map[doctor] || {};
    map[doctor][date] = map[doctor][date] || [];
    map[doctor][date].push(`${from}-${to}`);
  }
  return map;
}

/**
 * Returns all appointments for MRD numbers that appear more than once.
 */
function getDuplicateAppointments() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("appointment");
    if (!sheet)
      return { success: false, message: "Appointment sheet not found" };

    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const mrdCol = headers.indexOf("MRDNo");
    if (mrdCol < 0)
      return { success: false, message: "MRDNo column not found" };

    // 1. Count occurrences
    const counts = {};
    for (let i = 1; i < data.length; i++) {
      const mrd = data[i][mrdCol];
      if (mrd) counts[mrd] = (counts[mrd] || 0) + 1;
    }
    const duplicates = Object.keys(counts).filter((m) => counts[m] > 1);
    if (duplicates.length === 0) {
      return { success: false, message: "No MRD with multiple appointments" };
    }

    // Helper function to safely format dates
    function safeFormatDate(dateValue, format) {
      try {
        if (!dateValue) return "N/A";
        let date;
        if (dateValue instanceof Date) {
          date = dateValue;
        } else {
          date = new Date(dateValue);
        }
        if (isNaN(date.getTime())) return "Invalid Date";
        return Utilities.formatDate(date, Session.getScriptTimeZone(), format);
      } catch (e) {
        return "Invalid Date";
      }
    }

    // Helper function to safely get column value
    function safeGetValue(row, columnIndex) {
      try {
        if (columnIndex < 0 || columnIndex >= row.length) return "";
        const value = row[columnIndex];
        return value !== null && value !== undefined ? value.toString() : "";
      } catch (e) {
        return "";
      }
    }

    // 2. Build appointment objects for duplicates
    const col = (name) => headers.indexOf(name);
    const appts = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (duplicates.includes(row[mrdCol])) {
        try {
          appts.push({
            AppointmentID: safeGetValue(row, col("AppointmentID")),
            AppointmentDate: safeFormatDate(
              row[col("AppointmentDate")],
              "yyyy-MM-dd",
            ),
            TimeSlot: safeFormatDate(row[col("TimeSlot")], "hh:mm a"),
            MRDNo: safeGetValue(row, mrdCol),
            PatientName: safeGetValue(row, col("PatientName")),
            Gender: safeGetValue(row, col("Gender")),
            Age: safeGetValue(row, col("Age")),
            Phone: safeGetValue(row, col("Phone")),
            AppointmentType: safeGetValue(row, col("AppointmentType")),
            Doctor: safeGetValue(row, col("Doctor")),
            FixedSlot: safeGetValue(row, col("FixedSlot")),
            PlanOfAction: safeGetValue(row, col("PlanOfAction")),
            Remarks: safeGetValue(row, col("Remarks")),
          });
        } catch (e) {
          // Log the error for this specific row but continue processing

          continue;
        }
      }
    }

    // 3. Sort by MRD, then by appointment date and time
    appts.sort((a, b) => {
      if (a.MRDNo !== b.MRDNo) {
        return a.MRDNo.localeCompare(b.MRDNo);
      }
      // For same MRD, sort by appointment date, then time
      if (a.AppointmentDate !== b.AppointmentDate) {
        return a.AppointmentDate.localeCompare(b.AppointmentDate);
      }
      return a.TimeSlot.localeCompare(b.TimeSlot);
    });

    return { success: true, appointments: appts, total: appts.length };
  } catch (e) {
    return {
      success: false,
      message: "Error retrieving duplicate appointments: " + e.toString(),
    };
  }
}

/**
 * Get cancelled appointments with duplicate MRD numbers
 * @return {Object} Success status and list of appointments with duplicate MRDs
 */
function getDuplicateCancelledAppointments() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("cancel");
    if (!sheet) return { success: false, message: "Cancel sheet not found" };

    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const mrdCol = headers.indexOf("MRDNo");
    if (mrdCol < 0)
      return { success: false, message: "MRDNo column not found" };

    // 1. Count occurrences
    const counts = {};
    for (let i = 1; i < data.length; i++) {
      const mrd = data[i][mrdCol];
      if (mrd) counts[mrd] = (counts[mrd] || 0) + 1;
    }
    const duplicates = Object.keys(counts).filter((m) => counts[m] > 1);
    if (duplicates.length === 0) {
      return {
        success: false,
        message: "No MRD with multiple cancelled appointments",
      };
    }

    // Helper function to safely format dates
    function safeFormatDate(dateValue, format) {
      try {
        if (!dateValue) return "N/A";
        let date;
        if (dateValue instanceof Date) {
          date = dateValue;
        } else {
          date = new Date(dateValue);
        }
        if (isNaN(date.getTime())) return "Invalid Date";
        return Utilities.formatDate(date, Session.getScriptTimeZone(), format);
      } catch (e) {
        return "Invalid Date";
      }
    }

    // Helper function to safely get column value
    function safeGetValue(row, columnIndex) {
      try {
        if (columnIndex < 0 || columnIndex >= row.length) return "";
        const value = row[columnIndex];
        return value !== null && value !== undefined ? value.toString() : "";
      } catch (e) {
        return "";
      }
    }

    // 2. Build appointment objects for duplicates
    const col = (name) => headers.indexOf(name);
    const appts = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (duplicates.includes(row[mrdCol])) {
        try {
          const callbackDate = row[col("CallbackDate")];
          const callbackDateFormatted = callbackDate
            ? safeFormatDate(callbackDate, "yyyy-MM-dd")
            : "";

          const deletedOn = row[col("DeletedOn")];
          const deletedOnFormatted = deletedOn
            ? safeFormatDate(deletedOn, "yyyy-MM-dd HH:mm")
            : "";

          appts.push({
            AppointmentID: safeGetValue(row, col("AppointmentID")),
            AppointmentDate: safeFormatDate(
              row[col("AppointmentDate")],
              "yyyy-MM-dd",
            ),
            TimeSlot: safeFormatDate(row[col("TimeSlot")], "HH:mm"),
            MRDNo: safeGetValue(row, mrdCol),
            PatientName: safeGetValue(row, col("PatientName")),
            Gender: safeGetValue(row, col("Gender")),
            Age: safeGetValue(row, col("Age")),
            Phone: safeGetValue(row, col("Phone")),
            AppointmentType: safeGetValue(row, col("AppointmentType")),
            Doctor: safeGetValue(row, col("Doctor")),
            PlanOfAction: safeGetValue(row, col("PlanOfAction")),
            Remarks: safeGetValue(row, col("Remarks")),
            DeletedOn: deletedOnFormatted,
            DeletedBy: safeGetValue(row, col("DeletedBy")),
            CallbackDate: callbackDateFormatted,
            isOverdue:
              callbackDate &&
              new Date(callbackDate) <
                new Date(new Date().setHours(0, 0, 0, 0)),
            isPastelMauve:
              row[col("ColumnAH")] &&
              row[col("ColumnAH")].toString().toLowerCase() === "yes",
          });
        } catch (e) {
          // Log the error for this specific row but continue processing
          continue;
        }
      }
    }

    // 3. Sort by MRD, then by appointment date and time
    appts.sort((a, b) => {
      if (a.MRDNo !== b.MRDNo) {
        return a.MRDNo.localeCompare(b.MRDNo);
      }
      // For same MRD, sort by appointment date, then time
      if (a.AppointmentDate !== b.AppointmentDate) {
        return a.AppointmentDate.localeCompare(b.AppointmentDate);
      }
      return a.TimeSlot.localeCompare(b.TimeSlot);
    });

    return { success: true, appointments: appts, total: appts.length };
  } catch (e) {
    return {
      success: false,
      message:
        "Error retrieving duplicate cancelled appointments: " + e.toString(),
    };
  }
}

/**
 * Updates the appointment sheet based on final selections
 * @param {string} date - The optimization date
 * @param {Array} finalSelections - Array of {mrd, time} objects
 * @return {Object} Status object
 */
function updateFinalAppointments(date, finalSelections) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentSheet = ss.getSheetByName("appointment");
    const optimizedScheduleSheet = ss.getSheetByName("Optimized Schedule");

    const data = appointmentSheet.getDataRange().getValues();
    const headers = data[0];

    // Get column indices from appointment sheet
    const mrdCol = headers.indexOf("MRDNo");
    const dateCol = headers.indexOf("AppointmentDate");
    const timeCol = headers.indexOf("TimeSlot");
    const typeCol = headers.indexOf("AppointmentType");
    const consultStartCol = headers.indexOf("Consult Start");

    if (mrdCol === -1 || dateCol === -1 || timeCol === -1 || typeCol === -1) {
      throw new Error("Required columns not found in appointment sheet");
    }

    // Get data from Optimized Schedule sheet
    let optimizedData = null;
    let optimizedHeaders = null;
    let mrdColOpt = -1;
    let checkInColOpt = -1;
    let consultStartColOpt = -1;

    if (optimizedScheduleSheet) {
      optimizedData = optimizedScheduleSheet.getDataRange().getValues();
      optimizedHeaders = optimizedData[0];
      mrdColOpt = optimizedHeaders.indexOf("MRD No");
      checkInColOpt = optimizedHeaders.indexOf("Check-In Time");
      consultStartColOpt = optimizedHeaders.indexOf("Consult Start");
    }

    // Format the date for comparison
    const formattedDate = Utilities.formatDate(
      new Date(date),
      Session.getScriptTimeZone(),
      "yyyy-MM-dd",
    );

    // Process each row in the appointment sheet
    for (let i = 1; i < data.length; i++) {
      const rowDate = Utilities.formatDate(
        new Date(data[i][dateCol]),
        Session.getScriptTimeZone(),
        "yyyy-MM-dd",
      );

      // Only process rows for the selected date
      if (rowDate === formattedDate) {
        const mrd = data[i][mrdCol].toString();
        const isSelected = finalSelections.some((sel) => sel.mrd === mrd);

        if (isSelected) {
          const selection = finalSelections.find((sel) => sel.mrd === mrd);

          // Try to find corresponding row in Optimized Schedule for Consult Start
          let consultStart = "";
          if (optimizedData && mrdColOpt !== -1 && consultStartColOpt !== -1) {
            for (let j = 1; j < optimizedData.length; j++) {
              if (optimizedData[j][mrdColOpt].toString() === mrd) {
                consultStart = optimizedData[j][consultStartColOpt];
                break;
              }
            }
          }

          // Update time slot (Check-in time) for selected appointments
          appointmentSheet
            .getRange(i + 1, timeCol + 1)
            .setValue(selection.time);
          appointmentSheet.getRange(i + 1, typeCol + 1).setValue("GENERAL");

          // Update Consult Start if column exists and we have the value
          if (consultStartCol !== -1 && consultStart) {
            // Format as HH:MM string if it's a Date object, otherwise use as-is if already a string
            let consultStartFormatted = consultStart;
            if (consultStart instanceof Date) {
              const consultHours = consultStart.getHours();
              const consultMinutes = consultStart.getMinutes();
              consultStartFormatted =
                ("0" + consultHours).slice(-2) +
                ":" +
                ("0" + consultMinutes).slice(-2);
            } else if (
              typeof consultStart === "string" &&
              consultStart.includes("/") &&
              consultStart.includes(":")
            ) {
              // If it's a date string like "13/12/2025 11:45:00", extract just the time part
              try {
                const dateObj = new Date(consultStart);
                if (!isNaN(dateObj.getTime())) {
                  const consultHours = dateObj.getHours();
                  const consultMinutes = dateObj.getMinutes();
                  consultStartFormatted =
                    ("0" + consultHours).slice(-2) +
                    ":" +
                    ("0" + consultMinutes).slice(-2);
                }
              } catch (e) {
                // If parsing fails, use as-is
              }
            }
            appointmentSheet
              .getRange(i + 1, consultStartCol + 1)
              .setValue(consultStartFormatted);
          }
        } else {
          // Set to WAITING LIST for non-selected appointments
          appointmentSheet
            .getRange(i + 1, typeCol + 1)
            .setValue("WAITING LIST");
          appointmentSheet.getRange(i + 1, timeCol + 1).setValue("");

          // Clear Consult Start for waiting list appointments
          if (consultStartCol !== -1) {
            appointmentSheet.getRange(i + 1, consultStartCol + 1).setValue("");
          }
        }
      }
    }

    // Clear the optimization sheets
    clearOptimizationSheets();

    return { success: true, message: "Appointments updated successfully" };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

function clearOptimizationSheets() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheetsToClear = [
      "slotOptimization",
      "Optimized Schedule",
      "Availability Blocks",
      "Utilization Report",
      "Reschedule List",
    ];

    sheetsToClear.forEach((sheetName) => {
      const sheet = ss.getSheetByName(sheetName);
      if (sheet) {
        sheet.clearContents();
        // Add headers back to slotOptimization sheet if it exists
        if (sheetName === "slotOptimization") {
          sheet.appendRow([
            "Date",
            "TimeSlot",
            "MRD No",
            "Patient Name",
            "Age",
            "Gender",
            "Mobile",
            "Procedures",
          ]);
        }
      }
    });

    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Generate a unique family identifier for appointments
 * @param {string} appointmentId - The appointment ID to update
 * @param {boolean} isFirstMember - Whether this is the first member of the family
 * @returns {Object} Success/failure response with the generated identifier
 */
function generateFamilyIdentifier(appointmentId, isFirstMember) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("appointment");

    if (!sheet) {
      return { success: false, message: "Appointment sheet not found." };
    }

    // Get headers and find Family Identifier column (AC)
    const headers = sheet
      .getRange(1, 1, 1, sheet.getLastColumn())
      .getValues()[0];
    const familyIdentifierColIndex = headers.indexOf("Family Identifier");

    if (familyIdentifierColIndex === -1) {
      return {
        success: false,
        message:
          "Family Identifier column not found. Please ensure column AC exists.",
      };
    }

    // Check if this is a temporary booking ID
    const isTemporaryBooking = appointmentId.startsWith("TEMP_BOOKING_");

    let familyIdentifier = "";

    if (isFirstMember) {
      // Generate a new family identifier
      const existingIdentifiers = [];

      // Collect all existing family identifiers from column AC
      const data = sheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        const existingValue = data[i][familyIdentifierColIndex];
        if (existingValue && existingValue.toString().trim().startsWith("F")) {
          const numericPart = existingValue.toString().trim().substring(1);
          const number = parseInt(numericPart, 10);
          if (!isNaN(number)) {
            existingIdentifiers.push(number);
          }
        }
      }

      // Find the smallest unused number from 1 to 1000
      let newNumber = 1;
      while (existingIdentifiers.includes(newNumber) && newNumber <= 1000) {
        newNumber++;
      }

      if (newNumber > 1000) {
        return {
          success: false,
          message: "Maximum family identifier limit reached (1000).",
        };
      }

      familyIdentifier = "F" + newNumber.toString().padStart(3, "0");
    } else {
      // This is not the first member, so we need to find the first member's identifier
      // For now, we'll generate a new identifier and let the user manually link them
      // In a more complex implementation, you might want to add a "Family Group" field
      // that links to the first member's appointment ID

      // For simplicity, we'll generate a new identifier and suggest manual linking
      const existingIdentifiers = [];
      const data = sheet.getDataRange().getValues();

      for (let i = 1; i < data.length; i++) {
        const existingValue = data[i][familyIdentifierColIndex];
        if (existingValue && existingValue.toString().trim().startsWith("F")) {
          const numericPart = existingValue.toString().trim().substring(1);
          const number = parseInt(numericPart, 10);
          if (!isNaN(number)) {
            existingIdentifiers.push(number);
          }
        }
      }

      let newNumber = 1;
      while (existingIdentifiers.includes(newNumber) && newNumber <= 1000) {
        newNumber++;
      }

      if (newNumber > 1000) {
        return {
          success: false,
          message: "Maximum family identifier limit reached (1000).",
        };
      }

      familyIdentifier = "F" + newNumber.toString().padStart(3, "0");
    }

    // Only write to the sheet if this is not a temporary booking
    if (!isTemporaryBooking) {
      // Find the appointment row
      const data = sheet.getDataRange().getValues();
      let rowIndex = -1;

      for (let i = 1; i < data.length; i++) {
        if (data[i][0].toString() === appointmentId) {
          rowIndex = i;
          break;
        }
      }

      if (rowIndex === -1) {
        return { success: false, message: "Appointment not found." };
      }

      // Write the family identifier to the appointment row
      sheet
        .getRange(rowIndex + 1, familyIdentifierColIndex + 1)
        .setValue(familyIdentifier);
    }

    return {
      success: true,
      message: `Family identifier ${familyIdentifier} assigned successfully.`,
      familyIdentifier: familyIdentifier,
    };
  } catch (error) {
    return {
      success: false,
      message: "Error generating family identifier: " + error.toString(),
    };
  }
}

/**
 * Assign a manually entered family identifier to an appointment
 * @param {string} appointmentId - The appointment ID to update
 * @param {string} manualIdentifier - The manually entered family identifier (e.g. F001)
 * @returns {Object} Success/failure response
 */
function assignManualFamilyIdentifier(
  appointmentId,
  manualIdentifier,
  sessionToken,
) {
  try {
    // Validate session
    const session = getUserSession(sessionToken);
    if (!session) {
      return { success: false, message: "Invalid session" };
    }

    // Get the appointments sheet
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentsSheet = ss.getSheetByName("appointment");

    if (!appointmentsSheet) {
      return { success: false, message: "Appointments sheet not found" };
    }

    // Find the appointment by ID
    const data = appointmentsSheet.getDataRange().getValues();
    let appointmentRow = -1;

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === appointmentId) {
        // Column A contains AppointmentID
        appointmentRow = i + 1; // +1 because sheet rows are 1-indexed
        break;
      }
    }

    if (appointmentRow === -1) {
      return { success: false, message: "Appointment not found" };
    }

    // Update column AC (index 28) with the manual family identifier
    appointmentsSheet.getRange(appointmentRow, 29).setValue(manualIdentifier); // Column AC is index 28, but getRange is 1-indexed so 29

    return {
      success: true,
      message: `Family identifier ${manualIdentifier} assigned successfully`,
      familyIdentifier: manualIdentifier,
    };
  } catch (error) {
    console.error("Error in assignManualFamilyIdentifier:", error);
    return {
      success: false,
      message: "Error assigning family identifier: " + error.toString(),
    };
  }
}

function getExistingFamilyIdentifiers() {
  try {
    // Get the appointments sheet
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentsSheet = ss.getSheetByName("appointment");

    if (!appointmentsSheet) {
      return { success: false, message: "Appointments sheet not found" };
    }

    // Get all values from column AC (index 28)
    const lastRow = appointmentsSheet.getLastRow();
    if (lastRow <= 1) {
      return { success: true, familyIdentifiers: [] };
    }

    const familyIdentifierRange = appointmentsSheet.getRange(
      2,
      29,
      lastRow - 1,
      1,
    ); // Column AC is index 29 (1-indexed)
    const familyIdentifierValues = familyIdentifierRange.getValues();

    // Extract unique, non-empty family identifiers
    const uniqueFamilyIdentifiers = new Set();

    familyIdentifierValues.forEach((row) => {
      const value = row[0];
      if (value && typeof value === "string" && value.trim() !== "") {
        uniqueFamilyIdentifiers.add(value.trim());
      }
    });

    // Convert to sorted array
    const sortedFamilyIdentifiers = Array.from(uniqueFamilyIdentifiers).sort();

    return {
      success: true,
      familyIdentifiers: sortedFamilyIdentifiers,
    };
  } catch (error) {
    console.error("Error in getExistingFamilyIdentifiers:", error);
    return {
      success: false,
      message: "Error fetching family identifiers: " + error.toString(),
    };
  }
}

/**
 * Get email-formatted day overview for printing
 * @param {string} date - The date to get overview for
 * @param {string} sessionToken - The session token
 * @return {Object} Object containing success status and HTML content
 */
function getEmailFormattedDayOverview(date, sessionToken) {
  try {
    // Validate session
    const session = getUserSession(sessionToken);
    if (!session) {
      return { success: false, message: "Invalid session" };
    }

    // Get appointments for the day
    const appointments = getAppointmentsForDay(date);
    if (!appointments || appointments.length === 0) {
      return {
        success: false,
        message: "No appointments found for the selected date",
      };
    }

    // Separate waiting list appointments from regular appointments
    const regularAppointments = appointments.filter(
      (appt) => appt.AppointmentType !== "WAITING LIST",
    );
    const waitingListAppointments = appointments.filter(
      (appt) => appt.AppointmentType === "WAITING LIST",
    );

    // Sort regular appointments by time
    regularAppointments.sort((a, b) => {
      const timeA = a.TimeSlot ? new Date(a.TimeSlot).getTime() : 0;
      const timeB = b.TimeSlot ? new Date(b.TimeSlot).getTime() : 0;
      return timeA - timeB;
    });

    // Sort waiting list appointments by patient name (alphabetically)
    waitingListAppointments.sort((a, b) => {
      const nameA = (a.PatientName || "").toUpperCase();
      const nameB = (b.PatientName || "").toUpperCase();
      return nameA.localeCompare(nameB);
    });

    // Combine: regular appointments first, then waiting list at the end
    const sortedAppointments = [
      ...regularAppointments,
      ...waitingListAppointments,
    ];

    // Helper function to format plan of action for human reading
    function formatPlanOfActionForPrint(planOfAction) {
      if (!planOfAction || planOfAction === "-" || planOfAction.trim() === "") {
        return "-";
      }

      try {
        // Try to parse as JSON first
        const plans = JSON.parse(planOfAction);
        const planArray = Array.isArray(plans) ? plans : [plans];

        return planArray
          .map((plan) => {
            if (typeof plan === "object" && plan.name) {
              // If it's an object with name and eye properties
              let formatted = plan.name;
              if (plan.eye) {
                formatted += ` (${plan.eye})`;
              }
              return formatted;
            } else {
              // If it's just a string
              return plan.toString();
            }
          })
          .join(", ");
      } catch (e) {
        // If not JSON, split by common separators and clean up
        const plans = planOfAction.split(/[/,;]/);
        return plans
          .map((plan) => plan.trim())
          .filter((plan) => plan !== "")
          .join(", ");
      }
    }

    // Create the same content as email but return HTML instead of sending
    const formattedDate = Utilities.formatDate(
      new Date(date),
      Session.getScriptTimeZone(),
      "EEEE, MMMM d, yyyy",
    );

    // Count appointments by type and plan of action
    const summary = {
      total: sortedAppointments.length,
      confirmed: 0,
      waitingList: 0,
      newPatients: 0,
      oldPatients: 0,
      planOfAction: {},
    };

    sortedAppointments.forEach((appt) => {
      if (appt.AppointmentType === "WAITING LIST") {
        summary.waitingList++;
      }
      if (appt.FourDayConfirmDate || appt.OneDayConfirmDate) {
        summary.confirmed++;
      }

      // Count new vs old patients based on MRD number
      const mrdNo = (appt.MRDNo || "").toString().trim().toUpperCase();
      if (mrdNo.startsWith("N")) {
        summary.newPatients++;
      } else if (mrdNo.startsWith("S") || (mrdNo && !mrdNo.startsWith("N"))) {
        summary.oldPatients++;
      }

      // Count plan of action occurrences (exclude "New" entries)
      if (appt.PlanOfAction && appt.PlanOfAction !== "-") {
        try {
          const plans = JSON.parse(appt.PlanOfAction);
          const planArray = Array.isArray(plans) ? plans : [plans];
          planArray.forEach((plan) => {
            const planName =
              typeof plan === "object" ? plan.name : plan.toString();
            // Skip if plan name contains "New" (case insensitive)
            if (!planName.toLowerCase().includes("new")) {
              summary.planOfAction[planName] =
                (summary.planOfAction[planName] || 0) + 1;
            }
          });
        } catch (e) {
          const plans = appt.PlanOfAction.split(/[/,;]/);
          plans.forEach((plan) => {
            const cleanPlan = plan.trim();
            // Skip if plan name contains "New" (case insensitive)
            if (cleanPlan && !cleanPlan.toLowerCase().includes("new")) {
              summary.planOfAction[cleanPlan] =
                (summary.planOfAction[cleanPlan] || 0) + 1;
            }
          });
        }
      }
    });

    // Generate HTML content (same as email)
    let htmlContent = `
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; line-height: 1.6; margin: 0; padding: 0; }
          .container { max-width: 800px; margin: 0 auto; padding: 20px; }
          .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #ddd; padding-bottom: 20px; }
          .header h1 { color: #2c3e50; margin: 0; }
          .header p { margin: 5px 0; color: #7f8c8d; }
          .summary { display: flex; justify-content: space-around; background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 30px; }
          .summary-item { text-align: center; }
          .summary-item h3 { margin: 0; font-size: 28px; color: #3498db; }
          .summary-item p { margin: 5px 0 0 0; font-weight: bold; color: #2c3e50; }
          .plan-summary { margin-bottom: 30px; }
          .plan-summary h2 { color: #2c3e50; border-bottom: 1px solid #ddd; padding-bottom: 10px; }
          .plan-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-top: 15px; }
          .plan-item { background-color: #f8f9fa; padding: 10px; border-radius: 5px; display: flex; justify-content: space-between; align-items: center; }
          .appointments-table { width: 100%; border-collapse: collapse; margin-top: 20px; }
          .appointments-table th, .appointments-table td { border: 1px solid #ddd; padding: 12px 8px; text-align: left; }
          .appointments-table th { background-color: #f8f9fa; font-weight: bold; color: #2c3e50; }
          .appointments-table th:first-child, .appointments-table td:first-child { width: 60px; text-align: center; font-weight: bold; }
          .appointments-table tr:nth-child(even) { background-color: #f9f9f9; }
          .appointments-table tr.waiting-list { background-color: #fff3cd; }
          .footer { margin-top: 30px; text-align: center; color: #7f8c8d; font-size: 12px; border-top: 1px solid #ddd; padding-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Day Overview Report</h1>
            <p>${formattedDate}</p>
          </div>

          <div class="summary">
            <div class="summary-item">
              <h3>${summary.total}</h3>
              <p>Total Appointments</p>
            </div>
            <div class="summary-item">
              <h3>${summary.confirmed}</h3>
              <p>Confirmed</p>
            </div>
            <div class="summary-item">
              <h3>${summary.waitingList}</h3>
              <p>Waiting List</p>
            </div>
            <div class="summary-item">
              <h3>${summary.newPatients}</h3>
              <p>New</p>
            </div>
            <div class="summary-item">
              <h3>${summary.oldPatients}</h3>
              <p>Old</p>
            </div>
          </div>

          ${
            Object.keys(summary.planOfAction).length > 0
              ? `
          <div class="plan-summary">
            <h2>Plan of Action Summary</h2>
            <div class="plan-grid">
              ${Object.entries(summary.planOfAction)
                .sort((a, b) => b[1] - a[1])
                .map(
                  ([plan, count]) => `
                  <div class="plan-item">
                    <span>${plan}</span>
                    <strong>${count}</strong>
                  </div>
                `,
                )
                .join("")}
            </div>
          </div>
          `
              : ""
          }

          <h2>Appointments Detail</h2>
          <table class="appointments-table">
            <thead>
              <tr>
                <th>S.No</th>
                <th>Time</th>
                <th>Consult Start</th>
                <th>MRD No</th>
                <th>Patient Name</th>
                <th>Gender</th>
                <th>Age</th>
                <th>Phone</th>
                <th>Member Type</th>
                <th>Plan of Action</th>
                <th>Remarks</th>
              </tr>
            </thead>
            <tbody>
              ${sortedAppointments
                .map((appt, index) => {
                  // For waiting list appointments, show "-" instead of time
                  const isWaitingList = appt.AppointmentType === "WAITING LIST";
                  const timeDisplay =
                    isWaitingList ||
                    !appt.TimeSlot ||
                    appt.TimeSlot === "" ||
                    appt.TimeSlot === "undefined"
                      ? "-"
                      : Utilities.formatDate(
                          new Date(appt.TimeSlot),
                          Session.getScriptTimeZone(),
                          "hh:mm a",
                        );
                  const consultStartDisplay =
                    appt["Consult Start"] &&
                    appt["Consult Start"] !== "" &&
                    appt["Consult Start"] !== "undefined"
                      ? Utilities.formatDate(
                          new Date(appt["Consult Start"]),
                          Session.getScriptTimeZone(),
                          "hh:mm a",
                        )
                      : "-";
                  return `
                <tr class="${isWaitingList ? "waiting-list" : ""}">
                  <td>${index + 1}</td>
                  <td>${timeDisplay}</td>
                  <td>${consultStartDisplay}</td>
                  <td>${appt.MRDNo}</td>
                  <td>${appt.PatientName}</td>
                  <td>${appt.Gender}</td>
                  <td>${appt.Age}</td>
                  <td>${appt.Phone}</td>
                  <td>${appt.PatientType || "-"}</td>
                  <td>${formatPlanOfActionForPrint(appt.PlanOfAction)}</td>
                  <td>${appt.Remarks || "-"}</td>
                </tr>
              `;
                })
                .join("")}
            </tbody>
          </table>

          <div class="footer">
            <p>This is an automated report generated from the Appointment Management System.</p>
            <p>Generated on ${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "MMMM d, yyyy 'at' hh:mm a")}</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return {
      success: true,
      htmlContent: htmlContent,
    };
  } catch (error) {
    return { success: false, message: error.toString() };
  }
}

/**
 * Update family identifier for an existing appointment (simple version)
 * @param {string} appointmentId - The appointment ID to update
 * @param {string} familyIdentifier - The family identifier to set
 * @param {string} sessionToken - Session token for validation
 * @returns {Object} Success/failure response
 */
function updateFamilyIdentifier(appointmentId, familyIdentifier, sessionToken) {
  try {
    // Validate session
    const session = getUserSession(sessionToken);
    if (!session) {
      return { success: false, message: "Invalid session" };
    }

    // Get the appointments sheet
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentsSheet = ss.getSheetByName("appointment");

    if (!appointmentsSheet) {
      return { success: false, message: "Appointments sheet not found" };
    }

    // Find the appointment by ID
    const data = appointmentsSheet.getDataRange().getValues();
    let appointmentRow = -1;

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === appointmentId) {
        // Column A contains AppointmentID
        appointmentRow = i + 1; // +1 because sheet rows are 1-indexed
        break;
      }
    }

    if (appointmentRow === -1) {
      return { success: false, message: "Appointment not found" };
    }

    // Update column AC (index 28) with the family identifier
    // Column AC is index 28, but getRange is 1-indexed so 29
    appointmentsSheet.getRange(appointmentRow, 29).setValue(familyIdentifier);

    return {
      success: true,
      message: `Family identifier ${familyIdentifier} updated successfully`,
      familyIdentifier: familyIdentifier,
    };
  } catch (error) {
    console.error("Error in updateFamilyIdentifier:", error);
    return {
      success: false,
      message: "Error updating family identifier: " + error.toString(),
    };
  }
}

/**
 * Updates the Fixed Slot status for an appointment
 * @param {string} appointmentId - The ID of the appointment to update
 * @param {boolean} isFixing - Whether to fix (true) or unfix (false) the slot
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Status object indicating success or failure
 */
function updateFixedSlotStatus(appointmentId, isFixing, sessionToken) {
  try {
    // Validate session
    const session = getUserSession(sessionToken);
    if (!session) {
      return {
        success: false,
        message: "Invalid session. Please log in again.",
      };
    }

    // Validate input
    if (!appointmentId) {
      return { success: false, message: "Appointment ID is required" };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentSheet = ss.getSheetByName("appointment");

    if (!appointmentSheet) {
      return { success: false, message: "Appointment sheet not found" };
    }

    // Get all data from the appointment sheet
    const data = appointmentSheet.getDataRange().getValues();
    const headers = data[0];

    // Find the AppointmentID column
    const appointmentIdCol = headers.indexOf("AppointmentID");
    if (appointmentIdCol === -1) {
      return { success: false, message: "AppointmentID column not found" };
    }

    // Find the Fixed Slot column (Column Z)
    let fixedSlotCol = headers.indexOf("Fixed Slot");
    if (fixedSlotCol === -1) {
      // If Fixed Slot column doesn't exist, add it to column Z (26)
      fixedSlotCol = 25; // 0-based index for column Z
      if (appointmentSheet.getLastColumn() < 26) {
        // If sheet doesn't have 26 columns yet, add columns up to Z
        appointmentSheet.insertColumnsAfter(
          appointmentSheet.getLastColumn(),
          26 - appointmentSheet.getLastColumn(),
        );
      }
      appointmentSheet.getRange(1, 26).setValue("Fixed Slot");
      fixedSlotCol = 25; // Update the index
    }

    // Find the appointment row
    let appointmentRowIndex = -1;
    for (let i = 1; i < data.length; i++) {
      if (
        data[i][appointmentIdCol] &&
        data[i][appointmentIdCol].toString() === appointmentId.toString()
      ) {
        appointmentRowIndex = i;
        break;
      }
    }

    if (appointmentRowIndex === -1) {
      return { success: false, message: "Appointment not found" };
    }

    // Update the Fixed Slot status
    const newValue = isFixing ? "Yes" : "";
    appointmentSheet
      .getRange(appointmentRowIndex + 1, fixedSlotCol + 1)
      .setValue(newValue);

    return {
      success: true,
      message: isFixing
        ? "Fixed status has been added"
        : "Fixed status has been removed",
      appointmentId: appointmentId,
      fixedStatus: newValue,
    };
  } catch (error) {
    return {
      success: false,
      message: "Error updating fixed slot status: " + error.toString(),
    };
  }
}

/**
 * Get comprehensive day timeline slots for modal display (OPTIMIZED VERSION)
 * Returns all slots (available and blocked) using same logic as load indicator
 * Performance improvements: Single sheet read, batch processing, reduced loops
 * Now includes procedure-based consultation durations from PlanOfActionMaster
 */
function getDayTimelineSlots(doctor, dateString) {
  try {
    // Get day name for availability lookup
    var appointmentDate = new Date(dateString);
    var dayNames = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    var dayOfWeek = dayNames[appointmentDate.getDay()];

    // OPTIMIZATION: Get all sheet data in one operation
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetsData = {};

    // Load all required sheet data at once
    try {
      var availabilitySheet = ss.getSheetByName("DoctorAvailability");
      sheetsData.availability = availabilitySheet
        ? availabilitySheet.getDataRange().getValues()
        : [];
    } catch (e) {
      sheetsData.availability = [];
    }

    try {
      var appointmentSheet = ss.getSheetByName("appointment");
      sheetsData.appointments = appointmentSheet
        ? appointmentSheet.getDataRange().getValues()
        : [];
    } catch (e) {
      sheetsData.appointments = [];
    }

    try {
      var exceptionsSheet = ss.getSheetByName("DoctorAvailabilityExceptions");
      sheetsData.exceptions = exceptionsSheet
        ? exceptionsSheet.getDataRange().getValues()
        : [];
    } catch (e) {
      sheetsData.exceptions = [];
    }

    // Load PlanOfActionMaster data for procedure durations
    try {
      var planOfActionSheet = ss.getSheetByName("PlanOfActionMaster");
      sheetsData.planOfAction = planOfActionSheet
        ? planOfActionSheet.getDataRange().getValues()
        : [];
    } catch (e) {
      sheetsData.planOfAction = [];
    }

    // Create procedure duration map from PlanOfActionMaster
    var procedureMap = {};
    if (sheetsData.planOfAction.length > 0) {
      var planHeaders = sheetsData.planOfAction[0];
      var procCol = planHeaders.indexOf("Plan of action");
      var consultCol = planHeaders.indexOf("ConsultMin");
      var prepCol = planHeaders.indexOf("PrepMin");
      var priorityCol = planHeaders.indexOf("Priority");

      for (var p = 1; p < sheetsData.planOfAction.length; p++) {
        var row = sheetsData.planOfAction[p];
        var procedure = row[procCol];
        if (procedure) {
          var procName = procedure.toString().trim().toUpperCase();
          var duration = parseInt(row[consultCol], 10) || 10;
          procedureMap[procName] = {
            duration: duration,
            prep: parseInt(row[prepCol], 10) || 0,
            priority: parseInt(row[priorityCol], 10) || 999,
          };
        }
      }
    }

    // Helper function to clean procedure names
    function cleanProcedureName(procedure) {
      return procedure
        .replace(/\s*\([^)]*\)\s*/, "")
        .trim()
        .toUpperCase();
    }

    // Helper function to calculate consultation time for procedures
    function calculateConsultTime(procedures) {
      if (!procedures || procedures.length === 0) return 10; // default

      var maxDuration = 0;
      var foundProcedures = [];

      for (var i = 0; i < procedures.length; i++) {
        var originalProc = procedures[i].toString().trim();
        var cleanProc = cleanProcedureName(originalProc);

        // Since procedureMap keys are already uppercase, direct match should work
        var procData = procedureMap[cleanProc];

        if (procData) {
          maxDuration = Math.max(maxDuration, procData.duration);
          foundProcedures.push(cleanProc + ":" + procData.duration + "min");
        } else {
          foundProcedures.push(cleanProc + ":NOT_FOUND");
        }
      }

      // Add debug logging

      return maxDuration || 10; // default if no procedures found
    }

    // OPTIMIZATION: Get doctor availability ranges from cached data
    var availabilityRanges = [];
    if (sheetsData.availability.length > 0) {
      var headers = sheetsData.availability[0];
      var dayIndex = headers.indexOf(dayOfWeek);
      if (dayIndex !== -1) {
        for (var i = 1; i < sheetsData.availability.length; i++) {
          if (sheetsData.availability[i][0].toString().trim() === doctor) {
            var cellValue = sheetsData.availability[i][dayIndex];
            if (cellValue) {
              availabilityRanges = cellValue.split(",").map(function (r) {
                return r.trim();
              });
            }
            break;
          }
        }
      }
    }

    // Generate all possible base slots from availability ranges (5-minute intervals for precision)
    var allBaseSlots = [];
    var baseInterval = 5; // 5-minute base intervals for more precision

    for (var r = 0; r < availabilityRanges.length; r++) {
      var parts = availabilityRanges[r].split("-");
      if (parts.length < 2) continue;

      var startTime = parts[0].trim();
      var endTime = parts[1].trim();
      var startMins = timeStringToMinutes(startTime);
      var endMins = timeStringToMinutes(endTime);

      for (var t = startMins; t < endMins; t += baseInterval) {
        allBaseSlots.push(t); // Store as minutes for easier calculation
      }
    }

    // Constants for lunch break
    var lunchStart = timeStringToMinutes("13:00");
    var lunchEnd = timeStringToMinutes("13:30");

    // OPTIMIZATION: Process appointments data in single pass to get booked slots with their durations
    var bookedSlotRanges = []; // Store as {start: mins, end: mins, formatted: "HH:mm"}
    var fixedSlots = [];
    var appointmentHeaders =
      sheetsData.appointments.length > 0 ? sheetsData.appointments[0] : [];
    var proceduresColIndex = appointmentHeaders.indexOf("Procedures");

    for (var i = 1; i < sheetsData.appointments.length; i++) {
      var rowDate = Utilities.formatDate(
        new Date(sheetsData.appointments[i][1]),
        Session.getScriptTimeZone(),
        "yyyy-MM-dd",
      );
      var rowDoctor = sheetsData.appointments[i][9]
        ? sheetsData.appointments[i][9].toString().trim()
        : "";

      if (rowDate === dateString && rowDoctor === doctor) {
        // Get booked time slot
        var timeSlotRaw = sheetsData.appointments[i][2];
        var formattedTime = Utilities.formatDate(
          new Date(timeSlotRaw),
          Session.getScriptTimeZone(),
          "HH:mm",
        );
        var slotStartMins = timeStringToMinutes(formattedTime);

        // Get procedures for this appointment to calculate duration
        var procedures = [];
        if (
          proceduresColIndex >= 0 &&
          sheetsData.appointments[i][proceduresColIndex]
        ) {
          var procString = sheetsData.appointments[i][proceduresColIndex]
            .toString()
            .trim();

          try {
            if (procString.startsWith("[") && procString.endsWith("]")) {
              // Handle JSON array format: ["REF","DIL","OCT (RE)"]
              procedures = JSON.parse(procString);
            } else if (procString.indexOf(",") > -1) {
              // Handle comma-separated format
              procedures = procString
                .split(",")
                .map(function (p) {
                  return p.trim();
                })
                .filter(function (p) {
                  return p;
                });
            } else if (procString) {
              // Single procedure
              procedures = [procString];
            }
          } catch (e) {
            procedures = [procString]; // fallback to single procedure
          }
        }

        // Calculate actual consultation duration
        var consultDuration = calculateConsultTime(procedures);
        var slotEndMins = slotStartMins + consultDuration;

        bookedSlotRanges.push({
          start: slotStartMins,
          end: slotEndMins,
          formatted: formattedTime,
          duration: consultDuration,
          procedures: procedures,
        });

        // Check if slot is fixed
        var isFixed = sheetsData.appointments[i][25]; // Column Z (0-based index 25)
        if (isFixed === "Yes") {
          fixedSlots.push(formattedTime);
        }
      }
    }

    // OPTIMIZATION: Get exception ranges from cached data
    var exceptions = [];
    for (var j = 1; j < sheetsData.exceptions.length; j++) {
      var rowDoctor = sheetsData.exceptions[j][0]?.toString().trim() || "";
      var rowDate = sheetsData.exceptions[j][1]
        ? Utilities.formatDate(
            new Date(sheetsData.exceptions[j][1]),
            Session.getScriptTimeZone(),
            "yyyy-MM-dd",
          )
        : "";

      if (rowDoctor === doctor && rowDate === dateString) {
        var fromTime = formatTimeString(sheetsData.exceptions[j][2]);
        var toTime = formatTimeString(sheetsData.exceptions[j][3]);

        if (fromTime && toTime) {
          exceptions.push(fromTime + "-" + toTime);
        }
      }
    }

    // Build available, blocked, and booked slot lists with proper durations
    var availableSlots = [];
    var blockedSlots = [];
    var bookedSlots = [];

    // Process base slots in 10-minute intervals for display
    var displayInterval = 10;
    for (
      var s = 0;
      s < allBaseSlots.length;
      s += displayInterval / baseInterval
    ) {
      var slotMins = allBaseSlots[s];
      var slotTime = formatTime(slotMins);
      var isBlocked = false;
      var isBooked = false;

      // Check lunch break
      if (slotMins >= lunchStart && slotMins < lunchEnd) {
        blockedSlots.push(slotTime);
        continue;
      }

      // Check if this slot overlaps with any booked appointment
      for (var b = 0; b < bookedSlotRanges.length; b++) {
        var booking = bookedSlotRanges[b];
        if (slotMins >= booking.start && slotMins < booking.end) {
          if (bookedSlots.indexOf(booking.formatted) === -1) {
            bookedSlots.push(booking.formatted);
          }
          isBooked = true;
          break;
        }
      }

      if (isBooked) continue;

      // Check exception ranges
      for (var e = 0; e < exceptions.length; e++) {
        var exParts = exceptions[e].split("-");
        if (exParts.length < 2) continue;

        var exStart = timeStringToMinutes(exParts[0]);
        var exEnd = timeStringToMinutes(exParts[1]);

        if (slotMins >= exStart && slotMins < exEnd) {
          isBlocked = true;
          break;
        }
      }

      if (isBlocked) {
        blockedSlots.push(slotTime);
      } else {
        availableSlots.push(slotTime);
      }
    }

    return {
      success: true,
      availableSlots: availableSlots,
      bookedSlots: bookedSlots,
      fixedSlots: fixedSlots,
      blockedSlots: blockedSlots,
      bookedDetails: bookedSlotRanges, // Additional detail for debugging
    };
  } catch (e) {
    return {
      success: false,
      message: e.toString(),
      availableSlots: [],
      bookedSlots: [],
      fixedSlots: [],
      blockedSlots: [],
    };
  }
}

/**
 * Move one appointment from "appointment" → "Archive" sheet.
 */

/**
 * Get comprehensive rescheduling analytics for dashboard
 * @return {Object} Rescheduling analytics data
 */
function getReschedulingAnalytics() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentSheet = ss.getSheetByName("appointment");
    const cancelSheet = ss.getSheetByName("cancel");
    const archiveSheet = ss.getSheetByName("Archive");
    const appointmentArchiveSheet = ss.getSheetByName("appointment_archive");

    const analytics = {
      totalReschedules: 0,
      reschedulesByReason: {},
      frequentReschedules: [],
      reschedulesByStaff: {},
      reschedulesByMonth: {},
      highRiskAppointments: [],
      averageReschedulesPerAppointment: 0,
      rescheduleTrend: {},
    };

    // Process appointment sheet
    if (appointmentSheet) {
      const appointmentData = appointmentSheet.getDataRange().getValues();
      const headers = appointmentData[0];

      // Use column U directly (index 20, since arrays are 0-indexed)
      const rescheduleHistoryCol = 20; // Column U

      // Safety check to ensure column U exists
      if (headers.length <= rescheduleHistoryCol) {
        return analytics;
      }

      const rescheduledByCol = headers.indexOf("RescheduledBy");
      const rescheduledDateCol = headers.indexOf("RescheduledDate");
      const appointmentIdCol = headers.indexOf("AppointmentID");
      const patientNameCol = headers.indexOf("PatientName");
      const mrdNoCol = headers.indexOf("MRDNo");

      for (let i = 1; i < appointmentData.length; i++) {
        const row = appointmentData[i];
        const rescheduleHistory = row[rescheduleHistoryCol];
        const rescheduledBy = row[rescheduledByCol];
        const rescheduledDate = row[rescheduledDateCol];
        const appointmentId = row[appointmentIdCol];
        const patientName = row[patientNameCol];
        const mrdNo = row[mrdNoCol];

        // Debug: Log first few rows to see what we're getting
        if (i <= 3) {
        }

        if (rescheduleHistory) {
          try {
            const history = JSON.parse(rescheduleHistory);
            analytics.totalReschedules += history.length;

            // Track by staff member
            history.forEach((entry) => {
              const staff = entry.by || "Unknown";
              analytics.reschedulesByStaff[staff] =
                (analytics.reschedulesByStaff[staff] || 0) + 1;

              // Track by month
              const date = new Date(entry.timestamp);
              const monthKey = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, "0")}`;
              analytics.reschedulesByMonth[monthKey] =
                (analytics.reschedulesByMonth[monthKey] || 0) + 1;
            });

            // Track frequent reschedules
            if (history.length >= 2) {
              analytics.frequentReschedules.push({
                appointmentId: appointmentId,
                patientName: patientName,
                mrdNo: mrdNo,
                rescheduleCount: history.length,
                lastReschedule: history[history.length - 1].timestamp,
                rescheduledBy: rescheduledBy,
              });
            }

            // High risk appointments (3+ reschedules)
            if (history.length >= 3) {
              analytics.highRiskAppointments.push({
                appointmentId: appointmentId,
                patientName: patientName,
                mrdNo: mrdNo,
                rescheduleCount: history.length,
                lastReschedule: history[history.length - 1].timestamp,
                rescheduledBy: rescheduledBy,
                history: history,
              });
            }
          } catch (e) {}
        }
      }
    }

    // Process cancel sheet
    if (cancelSheet) {
      const cancelData = cancelSheet.getDataRange().getValues();
      const headers = cancelData[0];
      const rescheduleHistoryCol = 20; // Column U
      const rescheduledByCol = headers.indexOf("RescheduledBy");
      const appointmentIdCol = headers.indexOf("AppointmentID");
      const patientNameCol = headers.indexOf("PatientName");
      const mrdNoCol = headers.indexOf("MRDNo");

      for (let i = 1; i < cancelData.length; i++) {
        const row = cancelData[i];
        const rescheduleHistory = row[rescheduleHistoryCol];
        const rescheduledBy = row[rescheduledByCol];
        const appointmentId = row[appointmentIdCol];
        const patientName = row[patientNameCol];
        const mrdNo = row[mrdNoCol];

        if (rescheduleHistory) {
          try {
            const history = JSON.parse(rescheduleHistory);
            analytics.totalReschedules += history.length;

            // Track by staff member
            history.forEach((entry) => {
              const staff = entry.by || "Unknown";
              analytics.reschedulesByStaff[staff] =
                (analytics.reschedulesByStaff[staff] || 0) + 1;

              // Track by month
              const date = new Date(entry.timestamp);
              const monthKey = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, "0")}`;
              analytics.reschedulesByMonth[monthKey] =
                (analytics.reschedulesByMonth[monthKey] || 0) + 1;
            });

            // Track frequent reschedules
            if (history.length >= 2) {
              analytics.frequentReschedules.push({
                appointmentId: appointmentId,
                patientName: patientName,
                mrdNo: mrdNo,
                rescheduleCount: history.length,
                lastReschedule: history[history.length - 1].timestamp,
                rescheduledBy: rescheduledBy,
                status: "Cancelled",
              });
            }
          } catch (e) {}
        }
      }
    }

    // Process archive sheet
    if (archiveSheet) {
      const archiveData = archiveSheet.getDataRange().getValues();
      const headers = archiveData[0];
      const rescheduleHistoryCol = 20; // Column U
      const rescheduledByCol = headers.indexOf("RescheduledBy");
      const appointmentIdCol = headers.indexOf("AppointmentID");
      const patientNameCol = headers.indexOf("PatientName");
      const mrdNoCol = headers.indexOf("MRDNo");

      for (let i = 1; i < archiveData.length; i++) {
        const row = archiveData[i];
        const rescheduleHistory = row[rescheduleHistoryCol];
        const rescheduledBy = row[rescheduledByCol];
        const appointmentId = row[appointmentIdCol];
        const patientName = row[patientNameCol];
        const mrdNo = row[mrdNoCol];

        if (rescheduleHistory) {
          try {
            const history = JSON.parse(rescheduleHistory);
            analytics.totalReschedules += history.length;

            // Track by staff member
            history.forEach((entry) => {
              const staff = entry.by || "Unknown";
              analytics.reschedulesByStaff[staff] =
                (analytics.reschedulesByStaff[staff] || 0) + 1;

              // Track by month
              const date = new Date(entry.timestamp);
              const monthKey = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, "0")}`;
              analytics.reschedulesByMonth[monthKey] =
                (analytics.reschedulesByMonth[monthKey] || 0) + 1;
            });
          } catch (e) {}
        }
      }
    }

    // Process appointment_archive sheet
    if (appointmentArchiveSheet) {
      const appointmentArchiveData = appointmentArchiveSheet
        .getDataRange()
        .getValues();
      const headers = appointmentArchiveData[0];
      const rescheduleHistoryCol = 20; // Column U
      const rescheduledByCol = headers.indexOf("RescheduledBy");
      const appointmentIdCol = headers.indexOf("AppointmentID");
      const patientNameCol = headers.indexOf("PatientName");
      const mrdNoCol = headers.indexOf("MRDNo");

      for (let i = 1; i < appointmentArchiveData.length; i++) {
        const row = appointmentArchiveData[i];
        const rescheduleHistory = row[rescheduleHistoryCol];
        const rescheduledBy = row[rescheduledByCol];
        const appointmentId = row[appointmentIdCol];
        const patientName = row[patientNameCol];
        const mrdNo = row[mrdNoCol];

        if (rescheduleHistory && rescheduleHistory.toString().trim() !== "") {
          try {
            const history = JSON.parse(rescheduleHistory);
            analytics.totalReschedules += history.length;

            // Track by staff member
            history.forEach((entry) => {
              const staff = entry.by || "Unknown";
              analytics.reschedulesByStaff[staff] =
                (analytics.reschedulesByStaff[staff] || 0) + 1;

              // Track by month
              const date = new Date(entry.timestamp);
              const monthKey = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, "0")}`;
              analytics.reschedulesByMonth[monthKey] =
                (analytics.reschedulesByMonth[monthKey] || 0) + 1;
            });

            // Track frequent reschedules
            if (history.length >= 2) {
              analytics.frequentReschedules.push({
                appointmentId: appointmentId,
                patientName: patientName,
                mrdNo: mrdNo,
                rescheduleCount: history.length,
                lastReschedule: history[history.length - 1].timestamp,
                rescheduledBy: rescheduledBy,
                status: "Archived",
              });
            }

            // High risk appointments (3+ reschedules)
            if (history.length >= 3) {
              analytics.highRiskAppointments.push({
                appointmentId: appointmentId,
                patientName: patientName,
                mrdNo: mrdNo,
                rescheduleCount: history.length,
                lastReschedule: history[history.length - 1].timestamp,
                rescheduledBy: rescheduledBy,
                history: history,
                status: "Archived",
              });
            }
          } catch (e) {}
        }
      }
    }

    // Calculate averages and trends
    const totalAppointments =
      (appointmentSheet ? appointmentSheet.getLastRow() - 1 : 0) +
      (cancelSheet ? cancelSheet.getLastRow() - 1 : 0) +
      (archiveSheet ? archiveSheet.getLastRow() - 1 : 0) +
      (appointmentArchiveSheet ? appointmentArchiveSheet.getLastRow() - 1 : 0);

    analytics.averageReschedulesPerAppointment =
      totalAppointments > 0
        ? parseFloat(
            (analytics.totalReschedules / totalAppointments).toFixed(2),
          )
        : 0;

    // Calculate current month reschedules
    const currentDate = new Date();
    const currentMonth = `${currentDate.getFullYear()}-${(currentDate.getMonth() + 1).toString().padStart(2, "0")}`;

    // Also try UTC month key in case of timezone issues
    const utcMonth = `${currentDate.getUTCFullYear()}-${(currentDate.getUTCMonth() + 1).toString().padStart(2, "0")}`;

    analytics.currentMonthReschedules =
      analytics.reschedulesByMonth[currentMonth] ||
      analytics.reschedulesByMonth[utcMonth] ||
      0;

    // Debug logging

    // Sort frequent reschedules by count
    analytics.frequentReschedules.sort(
      (a, b) => b.rescheduleCount - a.rescheduleCount,
    );
    analytics.highRiskAppointments.sort(
      (a, b) => b.rescheduleCount - a.rescheduleCount,
    );

    // Sort staff by reschedule count
    analytics.reschedulesByStaff = Object.fromEntries(
      Object.entries(analytics.reschedulesByStaff).sort(
        ([, a], [, b]) => b - a,
      ),
    );

    return analytics;
  } catch (e) {
    return {
      totalReschedules: 0,
      reschedulesByReason: {},
      frequentReschedules: [],
      reschedulesByStaff: {},
      reschedulesByMonth: {},
      highRiskAppointments: [],
      averageReschedulesPerAppointment: 0,
      rescheduleTrend: {},
      error: e.toString(),
    };
  }
}

/**
 * Get rescheduling frequency for a specific appointment ID
 * @param {string} appointmentId - The appointment ID to check
 * @return {Object} Rescheduling details for the appointment
 */
function getAppointmentRescheduleHistory(appointmentId) {
  try {
    // Validate input
    if (!appointmentId) {
      return { error: "Appointment ID is required" };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheets = ["appointment", "cancel", "Archive", "appointment_archive"];
    let foundAppointment = null;

    for (const sheetName of sheets) {
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) {
        continue;
      }

      const data = sheet.getDataRange().getValues();
      if (data.length < 2) {
        continue;
      }

      const headers = data[0];
      const appointmentIdCol = headers.indexOf("AppointmentID");
      const rescheduleHistoryCol = 20; // Column U
      const patientNameCol = headers.indexOf("PatientName");
      const mrdNoCol = headers.indexOf("MRDNo");
      const rescheduledByCol = headers.indexOf("RescheduledBy");
      const rescheduledDateCol = headers.indexOf("RescheduledDate");

      // Validate column indices
      if (appointmentIdCol === -1) {
        continue;
      }

      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (
          row[appointmentIdCol] &&
          row[appointmentIdCol].toString() === appointmentId.toString()
        ) {
          const rescheduleHistory = row[rescheduleHistoryCol];
          let history = [];

          if (rescheduleHistory && rescheduleHistory !== "") {
            try {
              history = JSON.parse(rescheduleHistory);
              if (!Array.isArray(history)) {
                history = [];
              } else {
                // Convert old format to new format if needed
                history = history.map((entry) => {
                  if (entry.previousDate && !entry.fromDate) {
                    // Convert old format to new format
                    return {
                      timestamp: entry.timestamp,
                      by: entry.by,
                      fromDate: entry.previousDate,
                      toDate: entry.previousDate, // We don't have the new date in old format
                      fromTime: entry.previousTime,
                      toTime: entry.previousTime, // We don't have the new time in old format
                      action: entry.action || "rescheduled",
                    };
                  }
                  return entry;
                });
              }
            } catch (e) {
              history = [];
            }
          }

          foundAppointment = {
            appointmentId: appointmentId,
            patientName: row[patientNameCol] || "Unknown",
            mrdNo: row[mrdNoCol] || "Unknown",
            currentSheet: sheetName,
            rescheduleCount: history.length,
            rescheduleHistory: history,
            lastRescheduledBy: row[rescheduledByCol] || "Unknown",
            lastRescheduledDate: row[rescheduledDateCol] || null,
            isHighRisk: history.length >= 3,
          };
          break;
        }
      }

      if (foundAppointment) break;
    }

    if (!foundAppointment) {
      // Debug: Let's check all sheets to see what's available
      const debugInfo = {
        appointmentId: appointmentId,
        sheetsChecked: [],
        availableSheets: [],
      };

      const allSheets = ss.getSheets();
      for (const sheet of allSheets) {
        const sheetName = sheet.getName();
        debugInfo.availableSheets.push(sheetName);

        if (sheets.includes(sheetName)) {
          const data = sheet.getDataRange().getValues();
          const headers = data[0];
          const appointmentIdCol = headers.indexOf("AppointmentID");

          if (appointmentIdCol !== -1) {
            let foundInThisSheet = false;
            for (let i = 1; i < data.length; i++) {
              const row = data[i];
              if (
                row[appointmentIdCol] &&
                row[appointmentIdCol].toString() === appointmentId.toString()
              ) {
                foundInThisSheet = true;
                break;
              }
            }
            debugInfo.sheetsChecked.push({
              sheetName: sheetName,
              hasAppointmentId: true,
              foundAppointment: foundInThisSheet,
              totalRows: data.length - 1,
            });
          } else {
            debugInfo.sheetsChecked.push({
              sheetName: sheetName,
              hasAppointmentId: false,
              foundAppointment: false,
              totalRows: data.length - 1,
            });
          }
        }
      }

      return { error: "Appointment not found", debug: debugInfo };
    }

    return foundAppointment;
  } catch (e) {
    return { error: e.toString() };
  }
}

/**
 * Get rescheduling statistics for dashboard cards
 * @return {Object} Quick stats for dashboard
 */
function getReschedulingStats() {
  try {
    const analytics = getReschedulingAnalytics();

    // Calculate trend (compare current month with previous month)
    const currentDate = new Date();
    const currentMonth = `${currentDate.getFullYear()}-${(currentDate.getMonth() + 1).toString().padStart(2, "0")}`;
    const previousMonth = new Date(
      currentDate.getFullYear(),
      currentDate.getMonth() - 1,
      1,
    );
    const previousMonthKey = `${previousMonth.getFullYear()}-${(previousMonth.getMonth() + 1).toString().padStart(2, "0")}`;

    const currentMonthReschedules =
      analytics.reschedulesByMonth[currentMonth] || 0;
    const previousMonthReschedules =
      analytics.reschedulesByMonth[previousMonthKey] || 0;

    let trend = 0;
    if (previousMonthReschedules > 0) {
      trend =
        ((currentMonthReschedules - previousMonthReschedules) /
          previousMonthReschedules) *
        100;
    }

    return {
      totalReschedules: analytics.totalReschedules,
      highRiskAppointments: analytics.highRiskAppointments.length,
      averageReschedulesPerAppointment:
        analytics.averageReschedulesPerAppointment,
      currentMonthReschedules: currentMonthReschedules,
      trend: trend,
      topReschedulingStaff: Object.keys(analytics.reschedulesByStaff).slice(
        0,
        3,
      ),
    };
  } catch (e) {
    return {
      totalReschedules: 0,
      highRiskAppointments: 0,
      averageReschedulesPerAppointment: 0,
      currentMonthReschedules: 0,
      trend: 0,
      topReschedulingStaff: [],
      error: e.toString(),
    };
  }
}

/**
 * Test function to debug current month reschedule calculation
 * @return {Object} Debug information about current month calculation
 */
function debugCurrentMonthReschedules() {
  try {
    const currentDate = new Date();
    const currentMonth = `${currentDate.getFullYear()}-${(currentDate.getMonth() + 1).toString().padStart(2, "0")}`;
    const utcMonth = `${currentDate.getUTCFullYear()}-${(currentDate.getUTCMonth() + 1).toString().padStart(2, "0")}`;

    // Test parsing a sample timestamp
    const sampleTimestamp = "2025-06-26T13:08:38.388Z";
    const sampleDate = new Date(sampleTimestamp);
    const sampleMonthKey = `${sampleDate.getFullYear()}-${(sampleDate.getMonth() + 1).toString().padStart(2, "0")}`;

    // Get analytics to see what month keys exist
    const analytics = getReschedulingAnalytics();

    return {
      currentDate: currentDate.toString(),
      currentMonthKey: currentMonth,
      utcMonthKey: utcMonth,
      sampleTimestamp: sampleTimestamp,
      sampleMonthKey: sampleMonthKey,
      availableMonthKeys: Object.keys(analytics.reschedulesByMonth),
      currentMonthReschedules: analytics.currentMonthReschedules,
      totalReschedules: analytics.totalReschedules,
      reschedulesByMonth: analytics.reschedulesByMonth,
    };
  } catch (e) {
    return { error: e.toString() };
  }
}

/**
 * Debug function to check sheet structure and column positions
 * @return {Object} Sheet structure information
 */
function debugSheetStructure() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentSheet = ss.getSheetByName("appointment");
    const cancelSheet = ss.getSheetByName("cancel");
    const archiveSheet = ss.getSheetByName("Archive");

    const debugInfo = {
      appointment: null,
      cancel: null,
      archive: null,
    };

    // Check appointment sheet
    if (appointmentSheet) {
      const appointmentData = appointmentSheet.getDataRange().getValues();
      const headers = appointmentData[0];

      debugInfo.appointment = {
        totalRows: appointmentData.length,
        headers: headers,
        rescheduleHistoryCol: headers.indexOf("RescheduleHistory"),
        rescheduleHistoryColU: headers.indexOf("U"), // Check if it's column U
        sampleData: appointmentData.length > 1 ? appointmentData[1] : null,
        cellU2: appointmentSheet.getRange("U2").getValue(),
      };
    }

    // Check cancel sheet
    if (cancelSheet) {
      const cancelData = cancelSheet.getDataRange().getValues();
      const headers = cancelData[0];

      debugInfo.cancel = {
        totalRows: cancelData.length,
        headers: headers,
        rescheduleHistoryCol: headers.indexOf("RescheduleHistory"),
        sampleData: cancelData.length > 1 ? cancelData[1] : null,
      };
    }

    // Check archive sheet
    if (archiveSheet) {
      const archiveData = archiveSheet.getDataRange().getValues();
      const headers = archiveData[0];

      debugInfo.archive = {
        totalRows: archiveData.length,
        headers: headers,
        rescheduleHistoryCol: headers.indexOf("RescheduleHistory"),
        sampleData: archiveData.length > 1 ? archiveData[1] : null,
      };
    }

    return debugInfo;
  } catch (e) {
    return { error: e.toString() };
  }
}

/**
 * Get booking analytics data for visualization
 * Returns booking counts by user (excluding doctors and admins) for a date range
 */
function getBookingAnalytics(fromDate, toDate) {
  try {
    const ss = SpreadsheetApp.getActive();

    // Cache user roles at the beginning to avoid repeated lookups
    const userRoleCache = {};
    const loginSheet = ss.getSheetByName("Login");
    if (loginSheet) {
      const loginData = loginSheet.getDataRange().getValues();

      for (let i = 1; i < loginData.length; i++) {
        const username = loginData[i][0];
        const role = loginData[i][2] || "user";
        userRoleCache[username] = role;
      }
    }

    const appointmentSheet = ss.getSheetByName("appointment");
    const archiveSheet = ss.getSheetByName("appointment_archive");

    if (!appointmentSheet && !archiveSheet) {
      return { success: false, message: "No appointment sheets found" };
    }

    const bookingData = {};

    // Process appointment sheet
    if (appointmentSheet) {
      const data = appointmentSheet.getDataRange().getValues();

      const headers = data[0];

      const bookedByCol = headers.indexOf("BookedBy");
      const bookingDateCol = headers.indexOf("BookingDate");

      if (bookedByCol === -1 || bookingDateCol === -1) {
        return {
          success: false,
          message: "Required columns not found in appointment sheet",
        };
      }

      let processedRows = 0;
      let validBookings = 0;
      let skippedRows = 0;

      for (let i = 1; i < data.length; i++) {
        processedRows++;

        // Log progress every 100 rows
        if (processedRows % 100 === 0) {
        }

        const row = data[i];
        const bookedBy = row[bookedByCol];
        const bookingDate = row[bookingDateCol];

        if (bookedBy && bookingDate) {
          // Check if user is not doctor or admin using cached role
          const userRole = userRoleCache[bookedBy] || "user";

          if (userRole !== "doctor" && userRole !== "admin") {
            // Check if booking date is within range
            try {
              const bookingDateObj = new Date(bookingDate);
              const fromDateObj = new Date(fromDate);
              const toDateObj = new Date(toDate);

              // Normalize dates to compare only date part (remove time component)
              const bookingDateOnly = new Date(
                bookingDateObj.getFullYear(),
                bookingDateObj.getMonth(),
                bookingDateObj.getDate(),
              );
              const fromDateOnly = new Date(
                fromDateObj.getFullYear(),
                fromDateObj.getMonth(),
                fromDateObj.getDate(),
              );
              const toDateOnly = new Date(
                toDateObj.getFullYear(),
                toDateObj.getMonth(),
                toDateObj.getDate(),
              );

              if (
                bookingDateOnly >= fromDateOnly &&
                bookingDateOnly <= toDateOnly
              ) {
                if (!bookingData[bookedBy]) {
                  bookingData[bookedBy] = 0;
                }
                bookingData[bookedBy]++;
                validBookings++;
              }
            } catch (dateError) {
              skippedRows++;
              continue;
            }
          } else {
            skippedRows++;
          }
        } else {
          skippedRows++;
        }
      }
    }

    // Process archive sheet
    if (archiveSheet) {
      const data = archiveSheet.getDataRange().getValues();

      const headers = data[0];

      const bookedByCol = headers.indexOf("BookedBy");
      const bookingDateCol = headers.indexOf("BookingDate");

      if (bookedByCol !== -1 && bookingDateCol !== -1) {
        let processedRows = 0;
        let validBookings = 0;
        let skippedRows = 0;

        for (let i = 1; i < data.length; i++) {
          processedRows++;

          // Log progress every 100 rows
          if (processedRows % 100 === 0) {
          }

          const row = data[i];
          const bookedBy = row[bookedByCol];
          const bookingDate = row[bookingDateCol];

          if (bookedBy && bookingDate) {
            // Check if user is not doctor or admin using cached role
            const userRole = userRoleCache[bookedBy] || "user";

            if (userRole !== "doctor" && userRole !== "admin") {
              // Check if booking date is within range
              try {
                const bookingDateObj = new Date(bookingDate);
                const fromDateObj = new Date(fromDate);
                const toDateObj = new Date(toDate);

                // Normalize dates to compare only date part (remove time component)
                const bookingDateOnly = new Date(
                  bookingDateObj.getFullYear(),
                  bookingDateObj.getMonth(),
                  bookingDateObj.getDate(),
                );
                const fromDateOnly = new Date(
                  fromDateObj.getFullYear(),
                  fromDateObj.getMonth(),
                  fromDateObj.getDate(),
                );
                const toDateOnly = new Date(
                  toDateObj.getFullYear(),
                  toDateObj.getMonth(),
                  toDateObj.getDate(),
                );

                if (
                  bookingDateOnly >= fromDateOnly &&
                  bookingDateOnly <= toDateOnly
                ) {
                  if (!bookingData[bookedBy]) {
                    bookingData[bookedBy] = 0;
                  }
                  bookingData[bookedBy]++;
                  validBookings++;
                }
              } catch (dateError) {
                skippedRows++;
                continue;
              }
            } else {
              skippedRows++;
            }
          } else {
            skippedRows++;
          }
        }
      } else {
      }
    }

    // Return bookingData as an object (not an array) for charts
    const totalBookings = Object.values(bookingData).reduce(
      (sum, count) => sum + count,
      0,
    );

    return {
      success: true,
      data: bookingData,
      totalBookings: totalBookings,
    };
  } catch (error) {
    return { success: false, message: error.toString() };
  }
}

/**
 * Get rescheduling analytics data for visualization
 * Returns rescheduling counts by user (excluding doctors and admins) for a date range
 */
function getReschedulingAnalyticsByDateRange(fromDate, toDate) {
  try {
    const ss = SpreadsheetApp.getActive();

    // Cache user roles at the beginning to avoid repeated lookups
    const userRoleCache = {};
    const loginSheet = ss.getSheetByName("Login");
    if (loginSheet) {
      const loginData = loginSheet.getDataRange().getValues();

      for (let i = 1; i < loginData.length; i++) {
        const username = loginData[i][0];
        const role = loginData[i][2] || "user";
        userRoleCache[username] = role;
      }
    }

    const appointmentSheet = ss.getSheetByName("appointment");
    const archiveSheet = ss.getSheetByName("appointment_archive");

    if (!appointmentSheet && !archiveSheet) {
      return { success: false, message: "No appointment sheets found" };
    }

    const reschedulingData = {};

    // Process appointment sheet
    if (appointmentSheet) {
      const data = appointmentSheet.getDataRange().getValues();

      const headers = data[0];

      const rescheduledByCol = headers.indexOf("RescheduledBy");
      const rescheduledDateCol = headers.indexOf("RescheduledDate");

      if (rescheduledByCol === -1 || rescheduledDateCol === -1) {
        return {
          success: false,
          message: "Required columns not found in appointment sheet",
        };
      }

      let processedRows = 0;
      let validReschedules = 0;
      let skippedRows = 0;

      for (let i = 1; i < data.length; i++) {
        processedRows++;

        // Log progress every 100 rows
        if (processedRows % 100 === 0) {
        }

        const row = data[i];
        const rescheduledBy = row[rescheduledByCol];
        const rescheduledDate = row[rescheduledDateCol];

        if (rescheduledBy && rescheduledDate) {
          // Check if user is not doctor or admin using cached role
          const userRole = userRoleCache[rescheduledBy] || "user";

          if (userRole !== "doctor" && userRole !== "admin") {
            // Check if reschedule date is within range
            try {
              const rescheduledDateObj = new Date(rescheduledDate);
              const fromDateObj = new Date(fromDate);
              const toDateObj = new Date(toDate);
              // Normalize dates to compare only date part (remove time component)
              const rescheduledDateOnly = new Date(
                rescheduledDateObj.getFullYear(),
                rescheduledDateObj.getMonth(),
                rescheduledDateObj.getDate(),
              );
              const fromDateOnly = new Date(
                fromDateObj.getFullYear(),
                fromDateObj.getMonth(),
                fromDateObj.getDate(),
              );
              const toDateOnly = new Date(
                toDateObj.getFullYear(),
                toDateObj.getMonth(),
                toDateObj.getDate(),
              );
              if (
                rescheduledDateOnly >= fromDateOnly &&
                rescheduledDateOnly <= toDateOnly
              ) {
                if (!reschedulingData[rescheduledBy]) {
                  reschedulingData[rescheduledBy] = 0;
                }
                reschedulingData[rescheduledBy]++;
                validReschedules++;
              }
            } catch (dateError) {
              skippedRows++;
              continue;
            }
          } else {
            skippedRows++;
          }
        } else {
          skippedRows++;
        }
      }
    }

    // Process archive sheet
    if (archiveSheet) {
      const data = archiveSheet.getDataRange().getValues();

      const headers = data[0];

      const rescheduledByCol = headers.indexOf("RescheduledBy");
      const rescheduledDateCol = headers.indexOf("RescheduledDate");

      if (rescheduledByCol !== -1 && rescheduledDateCol !== -1) {
        let processedRows = 0;
        let validReschedules = 0;
        let skippedRows = 0;

        for (let i = 1; i < data.length; i++) {
          processedRows++;

          // Log progress every 100 rows
          if (processedRows % 100 === 0) {
          }

          const row = data[i];
          const rescheduledBy = row[rescheduledByCol];
          const rescheduledDate = row[rescheduledDateCol];

          if (rescheduledBy && rescheduledDate) {
            // Check if user is not doctor or admin using cached role
            const userRole = userRoleCache[rescheduledBy] || "user";

            if (userRole !== "doctor" && userRole !== "admin") {
              // Check if reschedule date is within range
              try {
                const rescheduledDateObj = new Date(rescheduledDate);
                const fromDateObj = new Date(fromDate);
                const toDateObj = new Date(toDate);
                // Normalize dates to compare only date part (remove time component)
                const rescheduledDateOnly = new Date(
                  rescheduledDateObj.getFullYear(),
                  rescheduledDateObj.getMonth(),
                  rescheduledDateObj.getDate(),
                );
                const fromDateOnly = new Date(
                  fromDateObj.getFullYear(),
                  fromDateObj.getMonth(),
                  fromDateObj.getDate(),
                );
                const toDateOnly = new Date(
                  toDateObj.getFullYear(),
                  toDateObj.getMonth(),
                  toDateObj.getDate(),
                );
                if (
                  rescheduledDateOnly >= fromDateOnly &&
                  rescheduledDateOnly <= toDateOnly
                ) {
                  if (!reschedulingData[rescheduledBy]) {
                    reschedulingData[rescheduledBy] = 0;
                  }
                  reschedulingData[rescheduledBy]++;
                  validReschedules++;
                }
              } catch (dateError) {
                skippedRows++;
                continue;
              }
            } else {
              skippedRows++;
            }
          } else {
            skippedRows++;
          }
        }
      } else {
      }
    }

    // Convert to array format for chart
    const chartData = Object.keys(reschedulingData)
      .map((user) => ({
        user: user,
        count: reschedulingData[user],
      }))
      .sort((a, b) => b.count - a.count);

    const totalReschedules = Object.values(reschedulingData).reduce(
      (sum, count) => sum + count,
      0,
    );

    return {
      success: true,
      data: chartData,
      totalReschedules: totalReschedules,
    };
  } catch (error) {
    return { success: false, message: error.toString() };
  }
}

// ============================================================================
// ETERNAL APPOINTMENT TRACKING SYSTEM
// Implements the policy: NO APPOINTMENT IS EVER TRULY DELETED
// All appointments are tracked forever with complete journey history
// ============================================================================

/**
 * Ensure AppointmentJourney column exists in a sheet
 * Creates column AJ (index 35) if it doesn't exist
 * @param {Sheet} sheet - The sheet to check/modify
 * @return {number} The column index of AppointmentJourney (0-based), or -1 on error
 */
function ensureJourneyColumn(sheet) {
  try {
    const headers = sheet
      .getRange(1, 1, 1, sheet.getLastColumn())
      .getValues()[0];
    let journeyColIndex = headers.indexOf("AppointmentJourney");

    if (journeyColIndex === -1) {
      // AppointmentJourney column doesn't exist, add it to column AJ (36)
      journeyColIndex = 35; // 0-based index for column AJ
      if (sheet.getLastColumn() < 36) {
        // Add columns up to AJ
        sheet.insertColumnsAfter(
          sheet.getLastColumn(),
          36 - sheet.getLastColumn(),
        );
      }
      sheet.getRange(1, 36).setValue("AppointmentJourney");
    }

    return journeyColIndex;
  } catch (e) {
    return -1;
  }
}

/**
 * Log an appointment journey entry
 * @param {string} appointmentId - The appointment ID
 * @param {string} action - Action type: created|rescheduled|cancelled|deleted|archived|restored
 * @param {string} fromSheet - Source sheet (or null for creation)
 * @param {string} toSheet - Destination sheet
 * @param {string} by - Username who performed the action
 * @param {Object} details - Additional details object (optional)
 */
function logAppointmentJourney(
  appointmentId,
  action,
  fromSheet,
  toSheet,
  by,
  details,
) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheets = ["appointment", "cancel", "Archive", "appointment_archive"];
    let targetSheet = null;
    let rowIndex = -1;

    // Find which sheet contains the appointment
    for (let i = 0; i < sheets.length; i++) {
      const sheet = ss.getSheetByName(sheets[i]);
      if (!sheet) continue;

      const data = sheet.getDataRange().getValues();
      for (let j = 1; j < data.length; j++) {
        if (data[j][0] && data[j][0].toString() === appointmentId) {
          targetSheet = sheet;
          rowIndex = j + 1; // Sheet rows are 1-indexed
          break;
        }
      }
      if (targetSheet) break;
    }

    if (!targetSheet) {
      return;
    }

    // Ensure journey column exists
    const journeyColIndex = ensureJourneyColumn(targetSheet);
    if (journeyColIndex === -1) {
      return;
    }

    // Get existing journey
    const existingJourney = targetSheet
      .getRange(rowIndex, journeyColIndex + 1)
      .getValue();
    let journey = [];

    if (existingJourney && existingJourney.toString().trim() !== "") {
      try {
        journey = JSON.parse(existingJourney);
      } catch (e) {
        journey = [];
      }
    }

    // Create new journey entry
    const entry = {
      timestamp: new Date().toISOString(),
      action: action,
      by: by,
      fromSheet: fromSheet,
      toSheet: toSheet,
    };

    // Add optional details
    if (details) {
      if (details.fromDate) entry.fromDate = details.fromDate;
      if (details.toDate) entry.toDate = details.toDate;
      if (details.fromTime) entry.fromTime = details.fromTime;
      if (details.toTime) entry.toTime = details.toTime;
      if (details.description) entry.description = details.description;
      if (details.reason) entry.reason = details.reason;
    }

    // Append new entry
    journey.push(entry);

    // Save back to sheet
    targetSheet
      .getRange(rowIndex, journeyColIndex + 1)
      .setValue(JSON.stringify(journey));
  } catch (e) {}
}

/**
 * Find an appointment across all sheets
 * Searches in priority order: Archive → appointment → cancel → appointment_archive
 * @param {string} appointmentId - The appointment ID to find
 * @return {Object} Object with sheet, sheetName, headers, rowData, rowIndex
 */
function findAppointmentInAllSheets(appointmentId) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    // Search Archive first - most likely location for old appointments
    const sheetNames = [
      "Archive",
      "appointment",
      "cancel",
      "appointment_archive",
    ];

    for (let i = 0; i < sheetNames.length; i++) {
      const sheet = ss.getSheetByName(sheetNames[i]);
      if (!sheet) {
        continue;
      }

      const data = sheet.getDataRange().getValues();
      const headers = data[0];

      // Find AppointmentID column
      const idColIndex = headers.indexOf("AppointmentID");

      // For Archive sheet, also check for aFollowID (for archived followup appointments)
      const aFollowIDColIndex =
        sheetNames[i] === "Archive" ? headers.indexOf("aFollowID") : -1;

      // If neither AppointmentID nor aFollowID found, skip this sheet
      if (idColIndex === -1 && aFollowIDColIndex === -1) {
        continue;
      }

      // Search for the appointment
      for (let j = 1; j < data.length; j++) {
        // Check AppointmentID first
        if (
          idColIndex !== -1 &&
          data[j][idColIndex] &&
          data[j][idColIndex].toString() === appointmentId
        ) {
          return {
            sheet: sheet,
            sheetName: sheetNames[i],
            headers: headers,
            rowData: data[j],
            rowIndex: j + 1, // 1-indexed
          };
        }

        // Check aFollowID if available (for Archive sheet followup appointments)
        if (
          aFollowIDColIndex !== -1 &&
          data[j][aFollowIDColIndex] &&
          data[j][aFollowIDColIndex].toString() === appointmentId
        ) {
          return {
            sheet: sheet,
            sheetName: sheetNames[i],
            headers: headers,
            rowData: data[j],
            rowIndex: j + 1, // 1-indexed
          };
        }
      }
    }

    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Get the complete journey of an appointment
 * @param {string} appointmentId - The appointment ID
 * @return {Object} Object with success, journey array, and current location
 */
function getAppointmentJourney(appointmentId) {
  try {
    // Find the appointment across all sheets
    const location = findAppointmentInAllSheets(appointmentId);

    if (!location) {
      return {
        success: false,
        message: "Appointment not found in any sheet",
      };
    }

    // Ensure journey column exists and get its index
    const journeyColIndex = ensureJourneyColumn(location.sheet);

    if (journeyColIndex === -1) {
      return {
        success: true,
        journey: [],
        currentSheet: location.sheetName,
        message: "No journey data available (column error)",
      };
    }

    // Re-read the row data to get the latest column values after ensuring column exists
    const updatedRowData = location.sheet
      .getRange(location.rowIndex, 1, 1, location.sheet.getLastColumn())
      .getValues()[0];

    // Parse journey data from AppointmentJourney column (Column AJ)
    const journeyData = updatedRowData[journeyColIndex];
    let journey = [];

    if (journeyData && journeyData.toString().trim() !== "") {
      try {
        journey = JSON.parse(journeyData);
      } catch (e) {
        return {
          success: false,
          message: "Journey data is corrupted: " + e.toString(),
        };
      }
    } else {
    }

    // Sort journey by timestamp (oldest first)
    journey.sort(function (a, b) {
      const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return timeA - timeB;
    });

    // Format appointment data for JSON serialization
    const appointmentDate = updatedRowData[1];
    const appointmentTime = updatedRowData[2];

    // Convert Date objects to strings for JSON serialization
    const dateFormatted =
      appointmentDate instanceof Date
        ? Utilities.formatDate(
            appointmentDate,
            Session.getScriptTimeZone(),
            "yyyy-MM-dd",
          )
        : appointmentDate || "N/A";

    const timeFormatted =
      appointmentTime instanceof Date
        ? Utilities.formatDate(
            appointmentTime,
            Session.getScriptTimeZone(),
            "HH:mm",
          )
        : appointmentTime || "N/A";

    // Get patient name and ensure it's a string
    const patientName = updatedRowData[4] || updatedRowData[3] || "N/A";
    const patientNameStr = patientName ? patientName.toString() : "N/A";

    return {
      success: true,
      journey: journey,
      currentSheet: location.sheetName,
      appointmentData: {
        id: updatedRowData[0] ? updatedRowData[0].toString() : "N/A",
        date: dateFormatted,
        time: timeFormatted,
        patient: patientNameStr,
      },
    };
  } catch (e) {
    return {
      success: false,
      message: "Error retrieving journey: " + e.toString(),
    };
  }
}

/**
 * Test function to verify eternal tracking functions are deployed
 * Call this from the frontend to check if deployment is successful
 * @return {Object} Status of all eternal tracking functions
 */
function testEternalTrackingDeployment() {
  try {
    return {
      success: true,
      message: "Eternal tracking functions are deployed and working!",
      functionsAvailable: {
        ensureJourneyColumn: typeof ensureJourneyColumn === "function",
        logAppointmentJourney: typeof logAppointmentJourney === "function",
        findAppointmentInAllSheets:
          typeof findAppointmentInAllSheets === "function",
        getAppointmentJourney: typeof getAppointmentJourney === "function",
      },
      deploymentTime: new Date().toISOString(),
    };
  } catch (e) {
    return {
      success: false,
      message: "Error testing functions: " + e.toString(),
    };
  }
}

/**
 * Search archived appointments with pagination
 * @param {Object} searchParams - Search parameters (mrdNo, patientName, appointmentId, page, itemsPerPage)
 * @return {Object} Search results with appointments array and total count
 */
/**
 * Calculate and update Consult Start times for appointments that have TimeSlot but no Consult Start
 * This uses PlanOfActionMaster data to determine prep time
 */
function calculateConsultStartForAppointments() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentSheet = ss.getSheetByName("appointment");
    const planOfActionSheet = ss.getSheetByName("PlanOfActionMaster");

    if (!appointmentSheet || !planOfActionSheet) {
      return { success: false, message: "Required sheets not found" };
    }

    // Load PlanOfActionMaster data
    const planData = planOfActionSheet.getDataRange().getValues();
    const planHeaders = planData[0];
    const procedureMap = new Map();

    const procCol = planHeaders.indexOf("Plan of action");
    const prepCol = planHeaders.indexOf("PrepMin");

    // Build procedure map with prep times
    for (let i = 1; i < planData.length; i++) {
      const procedure = planData[i][procCol];
      if (procedure) {
        procedureMap.set(procedure.toString().trim().toUpperCase(), {
          prep: parseInt(planData[i][prepCol], 10) || 0,
        });
      }
    }

    // Process appointment sheet
    const data = appointmentSheet.getDataRange().getValues();
    const headers = data[0];

    const appointmentDateCol = headers.indexOf("AppointmentDate");
    const timeSlotCol = headers.indexOf("TimeSlot");
    const consultStartCol = headers.indexOf("Consult Start");
    const planOfActionCol = headers.indexOf("PlanOfAction");

    if (
      appointmentDateCol === -1 ||
      timeSlotCol === -1 ||
      consultStartCol === -1 ||
      planOfActionCol === -1
    ) {
      return {
        success: false,
        message:
          "Required columns not found. Found: AppointmentDate=" +
          appointmentDateCol +
          ", TimeSlot=" +
          timeSlotCol +
          ", Consult Start=" +
          consultStartCol +
          ", PlanOfAction=" +
          planOfActionCol,
      };
    }

    let updatedCount = 0;

    // Process each appointment
    for (let i = 1; i < data.length; i++) {
      const appointmentDate = data[i][appointmentDateCol];
      const timeSlot = data[i][timeSlotCol];
      const consultStart = data[i][consultStartCol];
      const planOfAction = data[i][planOfActionCol];

      // Only process if AppointmentDate and TimeSlot exist but Consult Start is empty
      if (
        appointmentDate &&
        timeSlot &&
        (!consultStart || consultStart === "")
      ) {
        // Calculate max prep time from procedures
        let maxPrepTime = 0;

        try {
          let procedures = [];
          if (
            typeof planOfAction === "string" &&
            planOfAction.startsWith("[")
          ) {
            procedures = JSON.parse(planOfAction);
          } else if (planOfAction) {
            procedures = planOfAction
              .toString()
              .split(",")
              .map((p) => p.trim());
          }

          procedures.forEach((proc) => {
            let procName =
              typeof proc === "object" ? proc.name : proc.toString();
            procName = procName
              .replace(/\s*\([^)]*\)\s*/, "")
              .trim()
              .toUpperCase();

            const procData = procedureMap.get(procName);
            if (procData) {
              maxPrepTime = Math.max(maxPrepTime, procData.prep);
            }
          });
        } catch (e) {}

        // Calculate Consult Start = AppointmentDate + TimeSlot + maxPrepTime
        try {
          // Get the date part from AppointmentDate
          const appointmentDateObj = new Date(appointmentDate);

          // Get the time part from TimeSlot
          const timeSlotObj = new Date(timeSlot);

          // Combine: use AppointmentDate's date with TimeSlot's time
          const combinedDateTime = new Date(
            appointmentDateObj.getFullYear(),
            appointmentDateObj.getMonth(),
            appointmentDateObj.getDate(),
            timeSlotObj.getHours(),
            timeSlotObj.getMinutes(),
            timeSlotObj.getSeconds(),
          );

          // Add prep time in minutes
          const consultStartDate = new Date(
            combinedDateTime.getTime() + maxPrepTime * 60000,
          );

          // Format as HH:MM string (time only, no date component)
          const consultHours = consultStartDate.getHours();
          const consultMinutes = consultStartDate.getMinutes();
          const consultStartTimeString =
            ("0" + consultHours).slice(-2) +
            ":" +
            ("0" + consultMinutes).slice(-2);

          // Update the Consult Start column with time string only
          appointmentSheet
            .getRange(i + 1, consultStartCol + 1)
            .setValue(consultStartTimeString);
          updatedCount++;
        } catch (e) {}
      }
    }

    return {
      success: true,
      message:
        "Updated " +
        updatedCount +
        " appointments with calculated Consult Start times",
      updatedCount: updatedCount,
    };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

function searchArchiveAppointments(searchParams) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const archiveSheet = ss.getSheetByName("Archive");

    if (!archiveSheet) {
      return {
        success: false,
        message: "Archive sheet not found",
      };
    }

    const data = archiveSheet.getDataRange().getValues();
    if (data.length <= 1) {
      return {
        success: true,
        appointments: [],
        total: 0,
      };
    }

    const headers = data[0];

    // Find column indices for all required columns with fallback options
    const appointmentIdCol = headers.indexOf("AppointmentID");
    const appointmentDateCol = headers.indexOf("AppointmentDate");
    const timeSlotCol = headers.indexOf("TimeSlot");
    const mrdCol = headers.indexOf("MRDNo");
    const nameCol =
      headers.indexOf("PatientName") >= 0
        ? headers.indexOf("PatientName")
        : headers.indexOf("Name");
    const ageCol = headers.indexOf("Age");
    const genderCol = headers.indexOf("Gender");
    const phoneCol = headers.indexOf("Phone");
    const appointmentTypeCol = headers.indexOf("AppointmentType");
    const doctorCol = headers.indexOf("Doctor");
    const planOfActionCol = headers.indexOf("PlanOfAction");
    const remarksCol = headers.indexOf("Remarks");
    const bookedByCol = headers.indexOf("BookedBy");
    const bookingDateCol = headers.indexOf("BookingDate");
    const fourDayConfirmDateCol = headers.indexOf("FourDayConfirmDate");
    const fourDayConfirmByCol = headers.indexOf("FourDayConfirmBy");
    const oneDayConfirmDateCol = headers.indexOf("OneDayConfirmDate");
    const oneDayConfirmByCol = headers.indexOf("OneDayConfirmBy");
    const rescheduledDateCol = headers.indexOf("RescheduledDate");
    const rescheduledByCol = headers.indexOf("RescheduledBy");
    const deletedOnCol =
      headers.indexOf("Deleted On") >= 0
        ? headers.indexOf("Deleted On")
        : headers.indexOf("DeletedOn");
    const deletedByCol =
      headers.indexOf("Deleted by") >= 0
        ? headers.indexOf("Deleted by")
        : headers.indexOf("DeletedBy");
    // Broaden header matching for archived columns
    const archivedOnCol =
      headers.indexOf("Archived on") >= 0
        ? headers.indexOf("Archived on")
        : headers.indexOf("ArchivedOn") >= 0
          ? headers.indexOf("ArchivedOn")
          : headers.indexOf("ArchivedDate") >= 0
            ? headers.indexOf("ArchivedDate")
            : -1;
    const archivedByCol =
      headers.indexOf("Archived by") >= 0
        ? headers.indexOf("Archived by")
        : headers.indexOf("ArchivedBy") >= 0
          ? headers.indexOf("ArchivedBy")
          : -1;
    const fixedSlotCol =
      headers.indexOf("Fixed Slot") >= 0
        ? headers.indexOf("Fixed Slot")
        : headers.indexOf("FixedSlot");
    const patientTypeCol = headers.indexOf("PatientType");
    const urgencyLevelCol =
      headers.indexOf("Urgency Level") >= 0
        ? headers.indexOf("Urgency Level")
        : headers.indexOf("UrgencyLevel");
    const aFollowIDCol = headers.indexOf("aFollowID");
    const tagCol = headers.indexOf("Tag");

    // Guard against missing critical indexes (allow aFollowID as alternative to AppointmentID for archived followups)
    if (mrdCol < 0 || nameCol < 0) {
      return {
        success: false,
        message:
          "Required columns (MRDNo, PatientName) not found in Archive sheet",
      };
    }

    // Normalize MRD search parameter (add SPD prefix if it's just a number)
    let normalizedMrdSearch = "";
    if (searchParams.mrdNo && searchParams.mrdNo.trim() !== "") {
      normalizedMrdSearch = searchParams.mrdNo.trim().toLowerCase();
      // If it's just a number, also search for SPD prefix version
      if (/^\d+$/.test(normalizedMrdSearch)) {
        normalizedMrdSearch = "spd" + normalizedMrdSearch;
      } else if (!normalizedMrdSearch.startsWith("spd")) {
        // If it has non-numeric characters but doesn't start with SPD, try to extract number
        const numMatch = normalizedMrdSearch.match(/\d+/);
        if (numMatch) {
          normalizedMrdSearch = "spd" + numMatch[0];
        }
      }
    }

    // Filter data based on search params
    let filteredData = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      let matches = true;

      // Guard against row length issues
      if (!row || row.length === 0) continue;

      // Ensure row has enough columns (at least for MRD column if searching by MRD)
      if (
        searchParams.mrdNo &&
        searchParams.mrdNo.trim() !== "" &&
        mrdCol >= 0 &&
        row.length <= mrdCol
      ) {
        continue; // Skip rows that don't have enough columns
      }

      // Filter by Appointment ID (skip if empty - allow followups without AppointmentID)
      if (
        searchParams.appointmentId &&
        searchParams.appointmentId.trim() !== ""
      ) {
        const appointmentId =
          appointmentIdCol >= 0 &&
          row.length > appointmentIdCol &&
          row[appointmentIdCol]
            ? row[appointmentIdCol].toString().toLowerCase()
            : "";
        if (
          appointmentId.indexOf(searchParams.appointmentId.toLowerCase()) === -1
        ) {
          matches = false;
        }
      }

      // Filter by MRD No (with normalization)
      if (searchParams.mrdNo && searchParams.mrdNo.trim() !== "") {
        const rowMrdNo =
          mrdCol >= 0 && row.length > mrdCol && row[mrdCol]
            ? row[mrdCol].toString().toLowerCase().trim()
            : "";
        const searchMrdLower = searchParams.mrdNo.trim().toLowerCase();

        // Check both the normalized version and the original search term
        const matchesNormalized =
          normalizedMrdSearch && rowMrdNo.indexOf(normalizedMrdSearch) !== -1;
        const matchesOriginal = rowMrdNo.indexOf(searchMrdLower) !== -1;

        if (!matchesNormalized && !matchesOriginal) {
          matches = false;
        }
      }

      // Filter by Patient Name
      if (searchParams.patientName && searchParams.patientName.trim() !== "") {
        const patientName =
          nameCol >= 0 && row[nameCol]
            ? row[nameCol].toString().toLowerCase()
            : "";
        if (
          patientName.indexOf(searchParams.patientName.toLowerCase()) === -1
        ) {
          matches = false;
        }
      }

      // Filter by Tag
      if (searchParams.tag && searchParams.tag.trim() !== "") {
        const tagString =
          tagCol >= 0 && row.length > tagCol && row[tagCol]
            ? row[tagCol].toString()
            : "";
        const tags = parseTagString(tagString);

        // Check if the selected tag exists in the appointment's tags
        if (!tags.includes(searchParams.tag.trim())) {
          matches = false;
        }
      }

      if (matches) {
        filteredData.push(row);
      }
    }

    // Get total count
    const total = filteredData.length;

    // Apply pagination
    const page = searchParams.page || 1;
    const itemsPerPage = searchParams.itemsPerPage || 10;
    const startIndex = (page - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const paginatedData = filteredData.slice(startIndex, endIndex);

    // Helper function to format dates
    function formatDate(dateValue) {
      if (!dateValue) return "";
      if (dateValue instanceof Date) {
        return Utilities.formatDate(
          dateValue,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd",
        );
      }
      // Try to parse string dates
      if (typeof dateValue === "string" && dateValue.trim() !== "") {
        try {
          const parsed = new Date(dateValue);
          if (!isNaN(parsed.getTime())) {
            return Utilities.formatDate(
              parsed,
              Session.getScriptTimeZone(),
              "yyyy-MM-dd",
            );
          }
        } catch (e) {
          // If parsing fails, return as-is
        }
      }
      return dateValue.toString();
    }

    // Helper function to format datetime
    function formatDateTime(dateValue) {
      if (!dateValue) return "";
      if (dateValue instanceof Date) {
        return Utilities.formatDate(
          dateValue,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd HH:mm",
        );
      }
      // Try to parse string dates
      if (typeof dateValue === "string" && dateValue.trim() !== "") {
        try {
          const parsed = new Date(dateValue);
          if (!isNaN(parsed.getTime())) {
            return Utilities.formatDate(
              parsed,
              Session.getScriptTimeZone(),
              "yyyy-MM-dd HH:mm",
            );
          }
        } catch (e) {
          // If parsing fails, return as-is
        }
      }
      return dateValue.toString();
    }

    // Helper function to format time
    function formatTime(dateValue) {
      if (!dateValue) return "";
      if (dateValue instanceof Date) {
        return Utilities.formatDate(
          dateValue,
          Session.getScriptTimeZone(),
          "HH:mm",
        );
      }
      // Try to parse string dates
      if (typeof dateValue === "string" && dateValue.trim() !== "") {
        try {
          const parsed = new Date(dateValue);
          if (!isNaN(parsed.getTime())) {
            return Utilities.formatDate(
              parsed,
              Session.getScriptTimeZone(),
              "HH:mm",
            );
          }
        } catch (e) {
          // If parsing fails, return as-is
        }
      }
      return dateValue.toString();
    }

    // Format results with all columns, guarding against missing indexes
    const appointments = paginatedData.map(function (row) {
      // Helper to safely get row value with index check
      function safeGet(index) {
        return index >= 0 && row && row.length > index ? row[index] : "";
      }

      // Get AppointmentID and aFollowID
      const appointmentId = safeGet(appointmentIdCol);
      const aFollowId = safeGet(aFollowIDCol);

      // For archived followup appointments, use aFollowID as AppointmentID if AppointmentID is empty
      const finalAppointmentId = appointmentId || aFollowId || "";

      return {
        AppointmentID: finalAppointmentId,
        AppointmentDate: formatDate(safeGet(appointmentDateCol)),
        TimeSlot: formatTime(safeGet(timeSlotCol)),
        MRDNo: safeGet(mrdCol),
        PatientName: safeGet(nameCol),
        Age: safeGet(ageCol),
        Gender: safeGet(genderCol),
        Phone: safeGet(phoneCol),
        AppointmentType: safeGet(appointmentTypeCol),
        Doctor: safeGet(doctorCol),
        PlanOfAction: safeGet(planOfActionCol),
        Remarks: safeGet(remarksCol),
        BookedBy: safeGet(bookedByCol),
        BookingDate: formatDateTime(safeGet(bookingDateCol)),
        FourDayConfirmDate: formatDate(safeGet(fourDayConfirmDateCol)),
        FourDayConfirmBy: safeGet(fourDayConfirmByCol),
        OneDayConfirmDate: formatDate(safeGet(oneDayConfirmDateCol)),
        OneDayConfirmBy: safeGet(oneDayConfirmByCol),
        RescheduledDate: formatDate(safeGet(rescheduledDateCol)),
        RescheduledBy: safeGet(rescheduledByCol),
        DeletedOn: formatDateTime(safeGet(deletedOnCol)),
        DeletedBy: safeGet(deletedByCol),
        ArchivedOn: formatDateTime(safeGet(archivedOnCol)),
        ArchivedBy: safeGet(archivedByCol),
        FixedSlot: safeGet(fixedSlotCol),
        PatientType: safeGet(patientTypeCol),
        UrgencyLevel: safeGet(urgencyLevelCol),
        aFollowID: safeGet(aFollowIDCol),
        Tag: parseTagString(safeGet(tagCol)),
      };
    });

    return {
      success: true,
      appointments: appointments,
      total: total,
    };
  } catch (e) {
    return {
      success: false,
      message: "Error searching archive: " + e.toString(),
    };
  }
}

/**
 * Search completed appointments from appointment_archive sheet
 * @param {Object} searchParams - Search parameters including filters and pagination
 * @return {Object} Search results with appointments array and total count
 */
function searchCompletedAppointments(searchParams) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const archiveSheet = ss.getSheetByName("appointment_archive");

    if (!archiveSheet) {
      return {
        success: false,
        message: "appointment_archive sheet not found",
      };
    }

    const data = archiveSheet.getDataRange().getValues();
    if (data.length <= 1) {
      return {
        success: true,
        appointments: [],
        total: 0,
      };
    }

    const headers = data[0];

    // Find column indices for all required columns (AppointmentID through Urgency Level)
    const appointmentIdCol = headers.indexOf("AppointmentID");
    const appointmentDateCol = headers.indexOf("AppointmentDate");
    const timeSlotCol = headers.indexOf("TimeSlot");
    const mrdCol = headers.indexOf("MRDNo");
    const nameCol = headers.indexOf("PatientName");
    const ageCol = headers.indexOf("Age");
    const genderCol = headers.indexOf("Gender");
    const phoneCol = headers.indexOf("Phone");
    const appointmentTypeCol = headers.indexOf("AppointmentType");
    const doctorCol = headers.indexOf("Doctor");
    const planOfActionCol = headers.indexOf("PlanOfAction");
    const remarksCol = headers.indexOf("Remarks");
    const bookedByCol = headers.indexOf("BookedBy");
    const bookingDateCol = headers.indexOf("BookingDate");
    const fourDayConfirmDateCol = headers.indexOf("FourDayConfirmDate");
    const fourDayConfirmByCol = headers.indexOf("FourDayConfirmBy");
    const oneDayConfirmDateCol = headers.indexOf("OneDayConfirmDate");
    const oneDayConfirmByCol = headers.indexOf("OneDayConfirmBy");
    const rescheduledDateCol = headers.indexOf("RescheduledDate");
    const rescheduledByCol = headers.indexOf("RescheduledBy");
    const rescheduleHistoryCol = headers.indexOf("RescheduleHistory");
    const deletedOnCol = headers.indexOf("Deleted On");
    const deletedByCol = headers.indexOf("Deleted by");
    const archivedOnCol = headers.indexOf("Archived on");
    const archivedByCol = headers.indexOf("Archived by");
    const fixedSlotCol = headers.indexOf("Fixed Slot");
    const patientTypeCol = headers.indexOf("PatientType");
    const urgencyLevelCol = headers.indexOf("Urgency Level");

    // Filter data based on search params
    let filteredData = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      let matches = true;

      // Filter by Appointment ID
      if (
        searchParams.appointmentId &&
        searchParams.appointmentId.trim() !== ""
      ) {
        const appointmentId = row[appointmentIdCol]
          ? row[appointmentIdCol].toString().toLowerCase()
          : "";
        if (
          appointmentId.indexOf(searchParams.appointmentId.toLowerCase()) === -1
        ) {
          matches = false;
        }
      }

      // Filter by MRD No
      if (searchParams.mrdNo && searchParams.mrdNo.trim() !== "") {
        const mrdNo = row[mrdCol] ? row[mrdCol].toString().toLowerCase() : "";
        if (mrdNo.indexOf(searchParams.mrdNo.toLowerCase()) === -1) {
          matches = false;
        }
      }

      // Filter by Patient Name
      if (searchParams.patientName && searchParams.patientName.trim() !== "") {
        const patientName = row[nameCol]
          ? row[nameCol].toString().toLowerCase()
          : "";
        if (
          patientName.indexOf(searchParams.patientName.toLowerCase()) === -1
        ) {
          matches = false;
        }
      }

      // Filter by Appointment Date
      if (
        searchParams.appointmentDate &&
        searchParams.appointmentDate.trim() !== ""
      ) {
        const appointmentDateValue = row[appointmentDateCol];
        if (appointmentDateValue) {
          let appointmentDateStr = "";
          if (appointmentDateValue instanceof Date) {
            appointmentDateStr = Utilities.formatDate(
              appointmentDateValue,
              Session.getScriptTimeZone(),
              "yyyy-MM-dd",
            );
          } else {
            appointmentDateStr = appointmentDateValue.toString();
          }
          if (appointmentDateStr !== searchParams.appointmentDate) {
            matches = false;
          }
        } else {
          matches = false;
        }
      }

      if (matches) {
        filteredData.push(row);
      }
    }

    // Get total count
    const total = filteredData.length;

    // Apply pagination
    const page = searchParams.page || 1;
    const itemsPerPage = searchParams.itemsPerPage || 10;
    const startIndex = (page - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const paginatedData = filteredData.slice(startIndex, endIndex);

    // Helper function to format dates
    function formatDate(dateValue) {
      if (!dateValue) return "";
      if (dateValue instanceof Date) {
        return Utilities.formatDate(
          dateValue,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd",
        );
      }
      return dateValue.toString();
    }

    // Helper function to format datetime
    function formatDateTime(dateValue) {
      if (!dateValue) return "";
      if (dateValue instanceof Date) {
        return Utilities.formatDate(
          dateValue,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd HH:mm",
        );
      }
      return dateValue.toString();
    }

    // Helper function to format time
    function formatTime(dateValue) {
      if (!dateValue) return "";
      if (dateValue instanceof Date) {
        return Utilities.formatDate(
          dateValue,
          Session.getScriptTimeZone(),
          "HH:mm",
        );
      }
      return dateValue.toString();
    }

    // Format results with all columns from AppointmentID through Urgency Level
    const appointments = paginatedData.map(function (row) {
      return {
        AppointmentID: row[appointmentIdCol] || "",
        AppointmentDate: formatDate(row[appointmentDateCol]),
        TimeSlot: formatTime(row[timeSlotCol]),
        MRDNo: row[mrdCol] || "",
        PatientName: row[nameCol] || "",
        Age: row[ageCol] || "",
        Gender: row[genderCol] || "",
        Phone: row[phoneCol] || "",
        AppointmentType: row[appointmentTypeCol] || "",
        Doctor: row[doctorCol] || "",
        PlanOfAction: row[planOfActionCol] || "",
        Remarks: row[remarksCol] || "",
        BookedBy: row[bookedByCol] || "",
        BookingDate: formatDateTime(row[bookingDateCol]),
        FourDayConfirmDate: formatDate(row[fourDayConfirmDateCol]),
        FourDayConfirmBy: row[fourDayConfirmByCol] || "",
        OneDayConfirmDate: formatDate(row[oneDayConfirmDateCol]),
        OneDayConfirmBy: row[oneDayConfirmByCol] || "",
        RescheduledDate: formatDate(row[rescheduledDateCol]),
        RescheduledBy: row[rescheduledByCol] || "",
        RescheduleHistory: row[rescheduleHistoryCol] || "",
        DeletedOn: formatDateTime(row[deletedOnCol]),
        DeletedBy: row[deletedByCol] || "",
        ArchivedOn: formatDateTime(row[archivedOnCol]),
        ArchivedBy: row[archivedByCol] || "",
        FixedSlot: row[fixedSlotCol] || "",
        PatientType: row[patientTypeCol] || "",
        UrgencyLevel: row[urgencyLevelCol] || "",
      };
    });

    return {
      success: true,
      appointments: appointments,
      total: total,
    };
  } catch (e) {
    return {
      success: false,
      message: "Error searching completed appointments: " + e.toString(),
    };
  }
}

// ===========================
// FOLLOWUP SYNC (followupMaster + followupMaster2 -> followup)
// ===========================

// followup / followupArchive layout:
//   A-N   followup fields (FOLLOWUP_CORE_HEADERS)
//   O-AA  patient fields from patientMaster (FOLLOWUP_PATIENT_HEADERS)
//   AF    tags (shared tag system, index 31)
//   AG-AL source + specialization/category fields (FOLLOWUP_EXTRA_HEADERS)
//   AM-AN followupArchive only: ArchiveReason, ArchivedOn
const FOLLOWUP_CORE_HEADERS = [
  "aFollowID",
  "npatient_id",
  "nappointment_id",
  "current_appointment_id",
  "follow_up_date",
  "appointment_status",
  "comments",
  "is_message_sent",
  "realised_appointment_id",
  "inserted_date",
  "updated_date",
  "isactive",
  "user_id",
  "rescheduledDate",
];
const FOLLOWUP_PATIENT_HEADERS = [
  "MRDNo",
  "PatientName",
  "DOB",
  "Age",
  "Gender",
  "Phone",
  "Address",
  "HomeNo",
  "WorkNo",
  "AdditionalInfo",
  "Type",
  "Status",
  "RegisteredOn",
];
const FOLLOWUP_EXTRA_HEADERS = [
  "Source",
  "BranchId",
  "SpecializationId",
  "SpecializationName",
  "CategoryId",
  "CategoryName",
];
const FOLLOWUP_ARCHIVE_EXTRA_HEADERS = ["ArchiveReason", "ArchivedOn"];
const FOLLOWUP_DATE_COL = 4; // Column E - follow_up_date
const FOLLOWUP_MRD_COL = 14; // Column O - MRDNo
const FOLLOWUP_TAG_COL = 31; // Column AF - Tags
const FOLLOWUP_EXTRA_START_COL = 32; // Column AG - Source
const FOLLOWUP_ROW_WIDTH =
  FOLLOWUP_EXTRA_START_COL + FOLLOWUP_EXTRA_HEADERS.length; // A-AL
const FOLLOWUP_ARCHIVE_ROW_WIDTH =
  FOLLOWUP_ROW_WIDTH + FOLLOWUP_ARCHIVE_EXTRA_HEADERS.length; // A-AN

const FOLLOWUP_COMMENTS_COL = 6; // Column G - comments

// Source sheets, filled daily by the hospital feed. They are only read here, never changed:
// the feed uses their last row / highest ID as its "synced up to here" marker.
// fieldMap: followup header -> source sheet header (matched case-insensitively).
const FOLLOWUP_SOURCES = [
  {
    code: "FM1",
    sheetName: "followupMaster",
    idPrefix: "",
    fieldMap: FOLLOWUP_CORE_HEADERS.reduce(function (map, header) {
      map[header] = header;
      return map;
    }, {}),
  },
  {
    code: "FM2",
    sheetName: "followupMaster2",
    idPrefix: "M2-",
    fieldMap: {
      aFollowID: "aFollowUpId",
      npatient_id: "nPatient_ID",
      nappointment_id: "nAppoint_ID",
      follow_up_date: "followUpDate",
      is_message_sent: "smsTriggerDate",
      inserted_date: "insertedDate",
      updated_date: "lastModifiedDate",
      rescheduledDate: "rescheduledDate",
      BranchId: "nhospitalbranchid",
      SpecializationId: "specilizationId",
      SpecializationName: "specilizationName",
      CategoryId: "categoryId",
      CategoryName: "categoryName",
    },
  },
];

// Sheets that record followups handled by staff (booked, cancelled, archived).
// They hold the followup ID in column AE (DirectCallIDs "DC_..." share the column and are ignored).
const FOLLOWUP_HANDLED_SHEETS = ["appointment", "cancel", "Archive", "appointment_archive"];
const FOLLOWUP_HANDLED_ID_COL = 30; // Column AE

/**
 * Rebuild the followup sheet from followupMaster (FM1) and followupMaster2 (FM2).
 * Runs daily via installFollowupTrigger(); the master sheets are never changed.
 * - Every master row dated today or later is shown, unless staff already booked, cancelled or
 *   archived it (its ID is in appointment / cancel / Archive / appointment_archive).
 * - Same patient + same date: one row is kept (FM2 over FM1, then the higher ID). The others go to
 *   followupArchive as DUPLICATE_SAME_DAY (once), their tags are merged into the kept row and a
 *   note is added to its comment history. Different dates are all kept; staff remove extras by hand.
 * - Rows leaving followup because their date has passed go to followupArchive as PAST_DATE.
 *   If the hospital later moves the date forward, the row comes back.
 * - Tags carry over from the previous followup row. The comment shown is the latest staff comment
 *   from CommentsHistory, otherwise the master's own comment.
 * - Patient details are refreshed from patientMaster on every run.
 * The result message is written to the execution log so manual runs from the editor show it.
 */
function syncFollowups() {
  const result = runFollowupSync_();
  Logger.log((result.success ? "OK: " : "FAILED: ") + result.message);
  return result;
}

function runFollowupSync_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return {
      success: false,
      message: "Another followup sync is already running. Please try again shortly.",
    };
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tz = Session.getScriptTimeZone();
    const now = new Date();
    const todayKey = Utilities.formatDate(now, tz, "yyyy-MM-dd");

    const patientMasterSheet = ss.getSheetByName("patientMaster");
    if (!patientMasterSheet) {
      return { success: false, message: "patientMaster sheet not found" };
    }

    // A missing or unreadable master would wipe its rows from followup, so stop instead
    const missingSheets = FOLLOWUP_SOURCES.filter(function (source) {
      return !ss.getSheetByName(source.sheetName);
    }).map(function (source) {
      return source.sheetName;
    });
    if (missingSheets.length > 0) {
      return {
        success: false,
        message: "Sheet(s) not found: " + missingSheets.join(", ") + ". Nothing was changed.",
      };
    }

    const followupSheet = getFollowupLayoutSheet_(ss, "followup", false);
    const archiveSheet = getFollowupLayoutSheet_(ss, "followupArchive", true);

    // 1. Inputs
    const previousRows = readFollowupRowsById_(followupSheet);
    const archiveState = readFollowupArchiveState_(archiveSheet, tz);
    const handledIds = readHandledFollowupIds_(ss);
    const staffComments = readLatestStaffComments_(ss);
    const patientLookup = buildFollowupPatientLookup_(patientMasterSheet, tz);

    const stats = {};
    const masterById = {};
    const candidates = [];
    for (let s = 0; s < FOLLOWUP_SOURCES.length; s++) {
      const source = FOLLOWUP_SOURCES[s];
      const result = readFollowupSourceRows_(
        ss.getSheetByName(source.sheetName),
        source,
        patientLookup,
        tz,
      );
      if (result.error) {
        return { success: false, message: result.error + ". Nothing was changed." };
      }

      const sourceStats = {
        masterRows: result.records.length,
        shown: 0,
        pastDate: 0,
        handledByStaff: 0,
        sameDaySkipped: 0,
        sameDayArchived: 0,
      };
      stats[source.code] = sourceStats;

      result.records.forEach(function (rec) {
        masterById[rec.id] = rec;
        if (rec.dateKey && rec.dateKey < todayKey) {
          sourceStats.pastDate++;
        } else if (handledIds[rec.id]) {
          sourceStats.handledByStaff++;
        } else if (archiveState.sameDayLosers[rec.id + "|" + rec.dateKey]) {
          sourceStats.sameDaySkipped++;
        } else {
          candidates.push(rec);
        }
      });
    }

    // 2. Same patient + same date: keep one, archive the others
    const archiveRows = [];
    const mergeNotes = [];
    const sameDayLog = [];
    const extraTags = {}; // kept row ID -> tags from the rows merged into it
    const groups = {};
    candidates.forEach(function (rec) {
      if (!rec.mrdKey || !rec.dateKey) return;
      const key = rec.mrdKey + "|" + rec.dateKey;
      if (!groups[key]) groups[key] = [];
      groups[key].push(rec);
    });

    Object.keys(groups).forEach(function (key) {
      const group = groups[key];
      if (group.length < 2) return;
      group.sort(compareFollowupSameDay_);
      const winner = group[0];

      group.slice(1).forEach(function (loser) {
        loser.removed = true;
        const previous = previousRows[loser.id];
        const loserTags = previous ? parseTagString(previous[FOLLOWUP_TAG_COL]) : [];
        extraTags[winner.id] = (extraTags[winner.id] || []).concat(loserTags);

        const archiveRow = loser.row.slice();
        archiveRow[FOLLOWUP_TAG_COL] = formatTagString(loserTags);
        if (
          addFollowupArchiveRow_(
            archiveRows,
            archiveState,
            archiveRow,
            loser.dateKey,
            "DUPLICATE_SAME_DAY",
            now,
          )
        ) {
          mergeNotes.push({
            id: winner.id,
            text:
              "Merged from " +
              loser.id +
              " (" +
              loser.source +
              ", same follow-up date " +
              loser.dateKey +
              ")",
          });
          sameDayLog.push({
            archivedId: loser.id,
            keptId: winner.id,
            mrdNo: winner.row[FOLLOWUP_MRD_COL],
            date: loser.dateKey,
          });
          stats[loser.source].sameDayArchived++;
        }
      });
    });

    // 3. Rows to show, with tags and staff comments carried over
    const shown = candidates.filter(function (rec) {
      return !rec.removed;
    });
    const shownIds = {};
    const countByMrd = {};
    shown.forEach(function (rec) {
      shownIds[rec.id] = true;
      const previous = previousRows[rec.id];
      rec.row[FOLLOWUP_TAG_COL] = formatTagString(
        mergeFollowupTags_(
          previous ? parseTagString(previous[FOLLOWUP_TAG_COL]) : [],
          extraTags[rec.id] || [],
        ),
      );
      if (staffComments[rec.id] !== undefined) {
        rec.row[FOLLOWUP_COMMENTS_COL] = staffComments[rec.id];
      }
      if (rec.mrdKey) countByMrd[rec.mrdKey] = (countByMrd[rec.mrdKey] || 0) + 1;
      stats[rec.source].shown++;
    });
    shown.sort(function (a, b) {
      if (a.dateKey !== b.dateKey) {
        if (!a.dateKey) return 1;
        if (!b.dateKey) return -1;
        return a.dateKey < b.dateKey ? -1 : 1;
      }
      return a.mrdKey < b.mrdKey ? -1 : a.mrdKey > b.mrdKey ? 1 : 0;
    });

    // 4. Rows leaving followup: archive past dates and rows no longer in either master
    let archivedPastDate = 0;
    let archivedNotInMaster = 0;
    Object.keys(previousRows).forEach(function (id) {
      if (shownIds[id]) return;
      const previous = previousRows[id];
      const master = masterById[id];
      if (master && master.dateKey && master.dateKey < todayKey) {
        if (
          addFollowupArchiveRow_(
            archiveRows,
            archiveState,
            previous,
            getFollowupDateKey_(previous[FOLLOWUP_DATE_COL], tz),
            "PAST_DATE",
            now,
          )
        ) {
          archivedPastDate++;
        }
      } else if (!master && !handledIds[id]) {
        if (
          addFollowupArchiveRow_(
            archiveRows,
            archiveState,
            previous,
            getFollowupDateKey_(previous[FOLLOWUP_DATE_COL], tz),
            "NOT_IN_MASTER",
            now,
          )
        ) {
          archivedNotInMaster++;
        }
      }
      // Handled by staff or merged as a same-day duplicate: nothing more to do
    });

    // 5. Write: archive first, then replace followup, then notes
    appendFollowupRows_(archiveSheet, archiveRows, FOLLOWUP_ARCHIVE_ROW_WIDTH);
    writeFollowupRows_(
      followupSheet,
      shown.map(function (rec) {
        return rec.row;
      }),
    );
    addFollowupSystemComments_(mergeNotes, now);

    // Markers used by the earlier incremental sync are no longer needed
    const props = PropertiesService.getScriptProperties();
    props.deleteProperty("FU_LAST_ID_FM1");
    props.deleteProperty("FU_LAST_ID_FM2");

    // 6. Audit + summary
    const patientsWithMultiple = Object.keys(countByMrd).filter(function (mrd) {
      return countByMrd[mrd] > 1;
    }).length;
    let sameDayArchived = 0;
    FOLLOWUP_SOURCES.forEach(function (source) {
      sameDayArchived += stats[source.code].sameDayArchived;
    });

    logAuditEvent(null, "SYNC_FOLLOWUPS", "FOLLOWUP", "followup", {
      sheetName: "followup",
      sources: stats,
      shownTotal: shown.length,
      archivedPastDate: archivedPastDate,
      archivedSameDayDuplicate: sameDayArchived,
      archivedNotInMaster: archivedNotInMaster,
      patientsWithMultipleFollowups: patientsWithMultiple,
      sameDayMerges: sameDayLog.slice(0, 200),
      sameDayMergesTruncated: sameDayLog.length > 200,
    });

    const message =
      "Sync completed. followup now has " +
      shown.length +
      " row(s) (" +
      FOLLOWUP_SOURCES.map(function (source) {
        return source.code + " " + stats[source.code].shown;
      }).join(", ") +
      "). Archived " +
      archivedPastDate +
      " past-date, " +
      sameDayArchived +
      " same-day duplicate and " +
      archivedNotInMaster +
      " not-in-master row(s). Patients with more than one followup: " +
      patientsWithMultiple;

    return {
      success: true,
      message: message,
      count: shown.length,
      deletedCount: archiveRows.length,
      stats: stats,
    };
  } catch (e) {
    return {
      success: false,
      message: "Error syncing followups: " + e.toString(),
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Header row for the followup sheet (or followupArchive when forArchive is true)
 */
function getFollowupLayoutHeaders_(forArchive) {
  const headers = new Array(FOLLOWUP_ROW_WIDTH).fill("");
  FOLLOWUP_CORE_HEADERS.concat(FOLLOWUP_PATIENT_HEADERS).forEach(function (h, i) {
    headers[i] = h;
  });
  headers[FOLLOWUP_TAG_COL] = "Tags";
  FOLLOWUP_EXTRA_HEADERS.forEach(function (h, i) {
    headers[FOLLOWUP_EXTRA_START_COL + i] = h;
  });
  return forArchive ? headers.concat(FOLLOWUP_ARCHIVE_EXTRA_HEADERS) : headers;
}

/**
 * Get or create a followup-layout sheet and make its header row match the layout the sync writes.
 * Older syncs set headers only when the sheet was first created (before HomeNo/WorkNo existed),
 * so out-of-date labels are corrected in place and logged.
 * Throws only if column A or E is a different field, i.e. this is not a followup-layout sheet.
 */
function getFollowupLayoutSheet_(ss, sheetName, forArchive) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }

  const expected = getFollowupLayoutHeaders_(forArchive);
  const width = expected.length;
  if (sheet.getMaxColumns() < width) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  }

  const current = sheet
    .getRange(1, 1, 1, width)
    .getValues()[0]
    .map(function (h) {
      return h === null || h === undefined ? "" : h.toString().trim();
    });

  [0, FOLLOWUP_DATE_COL].forEach(function (i) {
    if (current[i] !== "" && current[i] !== expected[i]) {
      throw new Error(
        sheetName +
          " column " +
          (i + 1) +
          " has header '" +
          current[i] +
          "' but '" +
          expected[i] +
          "' was expected - is this the right sheet?",
      );
    }
  });

  let changed = false;
  for (let i = 0; i < width; i++) {
    if (!expected[i] || current[i] === expected[i]) continue;
    if (i === FOLLOWUP_TAG_COL && current[i] !== "") continue; // keep any existing label on the tag column
    if (current[i] !== "") {
      Logger.log(
        sheetName +
          ": header of column " +
          (i + 1) +
          " changed from '" +
          current[i] +
          "' to '" +
          expected[i] +
          "'",
      );
    }
    current[i] = expected[i];
    changed = true;
  }

  if (changed) {
    sheet
      .getRange(1, 1, 1, width)
      .setValues([current])
      .setBackground("#4a90e2")
      .setFontColor("#ffffff")
      .setFontWeight("bold");
    sheet.setFrozenRows(1);
  }

  return sheet;
}

/**
 * Source code (FM1/FM2) for a followup ID, based on its prefix
 */
function getFollowupSourceFromId_(id) {
  const idText = (id === null || id === undefined ? "" : id).toString();
  for (let i = 0; i < FOLLOWUP_SOURCES.length; i++) {
    const prefix = FOLLOWUP_SOURCES[i].idPrefix;
    if (prefix && idText.indexOf(prefix) === 0) return FOLLOWUP_SOURCES[i].code;
  }
  return "FM1";
}

/**
 * Followup ID as text: "41229" for numbers (also "41229.0"), "M2-22722" as is
 */
function normalizeFollowupId_(value) {
  if (value === null || value === undefined) return "";
  const text = value.toString().trim();
  return /^\d+(\.0+)?$/.test(text) ? String(parseInt(text, 10)) : text;
}

/**
 * Wrap a followup-layout row with the keys used for duplicate resolution
 */
function makeFollowupRecord_(row, sourceCode, tz) {
  const id = normalizeFollowupId_(row[0]);
  return {
    id: id,
    source: sourceCode,
    row: row,
    mrdKey: (row[FOLLOWUP_MRD_COL] || "").toString().trim().toUpperCase(),
    dateKey: getFollowupDateKey_(row[FOLLOWUP_DATE_COL], tz),
    numericId: parseFloat(id.substring(id.lastIndexOf("-") + 1)) || 0,
  };
}

/**
 * Current followup rows by ID (A-AL)
 */
function readFollowupRowsById_(sheet) {
  const rowsById = {};
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return rowsById;
  sheet
    .getRange(2, 1, lastRow - 1, FOLLOWUP_ROW_WIDTH)
    .getValues()
    .forEach(function (row) {
      const id = normalizeFollowupId_(row[0]);
      if (id && !rowsById[id]) rowsById[id] = row;
    });
  return rowsById;
}

/**
 * What followupArchive already holds:
 * keys - "id|date|reason" of every archived row (so nothing is archived twice)
 * sameDayLosers - "id|date" of rows archived as DUPLICATE_SAME_DAY (skipped while the date is unchanged)
 */
function readFollowupArchiveState_(sheet, tz) {
  const state = { keys: {}, sameDayLosers: {} };
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return state;
  sheet
    .getRange(2, 1, lastRow - 1, FOLLOWUP_ARCHIVE_ROW_WIDTH)
    .getValues()
    .forEach(function (row) {
      const id = normalizeFollowupId_(row[0]);
      if (!id) return;
      const dateKey = getFollowupDateKey_(row[FOLLOWUP_DATE_COL], tz);
      const reason = (row[FOLLOWUP_ROW_WIDTH] || "").toString();
      state.keys[id + "|" + dateKey + "|" + reason] = true;
      if (reason === "DUPLICATE_SAME_DAY") {
        state.sameDayLosers[id + "|" + dateKey] = true;
      }
    });
  return state;
}

/**
 * Queue a row for followupArchive unless the same ID + date + reason is already archived
 * @return {boolean} true if queued
 */
function addFollowupArchiveRow_(archiveRows, archiveState, row, dateKey, reason, archivedOn) {
  const key = normalizeFollowupId_(row[0]) + "|" + dateKey + "|" + reason;
  if (archiveState.keys[key]) return false;
  archiveState.keys[key] = true;
  archiveRows.push(toFollowupArchiveRow_(row, reason, archivedOn));
  return true;
}

/**
 * IDs of followups staff have booked, cancelled or archived (column AE of the handled sheets)
 */
function readHandledFollowupIds_(ss) {
  const ids = {};
  FOLLOWUP_HANDLED_SHEETS.forEach(function (sheetName) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet || sheet.getLastRow() < 2) return;
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const headerCol = headers.indexOf("aFollowID");
    const col = headerCol !== -1 ? headerCol : FOLLOWUP_HANDLED_ID_COL;
    if (col >= sheet.getLastColumn()) return;

    sheet
      .getRange(2, col + 1, sheet.getLastRow() - 1, 1)
      .getValues()
      .forEach(function (r) {
        const id = normalizeFollowupId_(r[0]);
        if (!id) return;
        // Only followup IDs: plain numbers (FM1) or a source prefix + number (FM2)
        const isFollowupId = FOLLOWUP_SOURCES.some(function (source) {
          return source.idPrefix
            ? id.indexOf(source.idPrefix) === 0 &&
                /^\d+$/.test(id.substring(source.idPrefix.length))
            : /^\d+$/.test(id);
        });
        if (isFollowupId) ids[id] = true;
      });
  });
  return ids;
}

/**
 * Latest staff comment per followup ID from CommentsHistory (system notes are ignored)
 */
function readLatestStaffComments_(ss) {
  const comments = {};
  const sheet = ss.getSheetByName("CommentsHistory");
  if (!sheet || sheet.getLastRow() < 2) return comments;
  // Rows are appended in time order, so the last row per ID is the latest comment
  sheet
    .getRange(2, 1, sheet.getLastRow() - 1, 3)
    .getValues()
    .forEach(function (r) {
      const id = normalizeFollowupId_(r[0]);
      if (!id || r[2] === "SYSTEM") return;
      comments[id] = r[1];
    });
  return comments;
}

/**
 * Read every row of a master sheet and convert it to followup-layout records.
 * If an ID appears more than once, the lowest row wins (the feed's latest copy).
 * @return {Object} { records } or { error }
 */
function readFollowupSourceRows_(sheet, source, patientLookup, tz) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    return { error: source.sheetName + " has no data rows" };
  }

  const headerIndex = {};
  data[0].forEach(function (h, i) {
    const key = (h || "").toString().trim().toLowerCase();
    if (key && headerIndex[key] === undefined) headerIndex[key] = i;
  });

  const columns = {};
  Object.keys(source.fieldMap).forEach(function (target) {
    const idx = headerIndex[source.fieldMap[target].toLowerCase()];
    if (idx !== undefined) columns[target] = idx;
  });

  const missing = ["aFollowID", "npatient_id", "follow_up_date"].filter(
    function (target) {
      return columns[target] === undefined;
    },
  );
  if (missing.length > 0) {
    return {
      error:
        source.sheetName +
        ": required column(s) not found: " +
        missing
          .map(function (target) {
            return source.fieldMap[target];
          })
          .join(", "),
    };
  }

  const recordsById = {};
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const rawId = row[columns.aFollowID];
    if (rawId === "" || rawId === null) continue;
    if (isNaN(typeof rawId === "number" ? rawId : parseFloat(rawId))) continue;

    const fields = {};
    Object.keys(columns).forEach(function (target) {
      fields[target] = normalizeFollowupSourceValue_(target, row[columns[target]], tz);
    });
    fields.aFollowID = source.idPrefix
      ? source.idPrefix + rawId.toString().trim()
      : rawId;

    const patientId = row[columns.npatient_id];
    const mrdNo = patientId ? "SPD" + patientId.toString() : "";
    const outRow = buildFollowupRow_(fields, mrdNo, patientLookup, source.code);
    const record = makeFollowupRecord_(outRow, source.code, tz);
    recordsById[record.id] = record;
  }

  return {
    records: Object.keys(recordsById).map(function (id) {
      return recordsById[id];
    }),
  };
}

/**
 * Clean a source value: dates become "yyyy-MM-dd HH:mm:ss", and placeholders
 * (1900-01-01, "Select ...", 0 IDs) become blank
 */
function normalizeFollowupSourceValue_(field, value, tz) {
  if (value === null || value === undefined || value === "") return "";
  // A 1900 follow-up date is kept so it is treated as past and archived
  const keepPlaceholderDate = field === "follow_up_date";

  if (value instanceof Date) {
    if (isNaN(value.getTime())) return "";
    if (!keepPlaceholderDate && value.getFullYear() <= 1900) return "";
    return Utilities.formatDate(value, tz, "yyyy-MM-dd HH:mm:ss");
  }

  const text = value.toString().trim();
  if (!keepPlaceholderDate && /^1900-01-01/.test(text)) return "";
  if (/^select\s/i.test(text)) return "";
  if ((field === "SpecializationId" || field === "CategoryId") && text === "0") {
    return "";
  }
  return value || "";
}

/**
 * "yyyy-MM-dd" key for a follow-up date value, or "" if it is not a valid date
 */
function getFollowupDateKey_(value, tz) {
  if (!value) return "";
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? "" : Utilities.formatDate(value, tz, "yyyy-MM-dd");
  }
  const text = value.toString().trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return match[1] + "-" + match[2] + "-" + match[3];
  const parsed = new Date(text);
  return isNaN(parsed.getTime()) ? "" : Utilities.formatDate(parsed, tz, "yyyy-MM-dd");
}

/**
 * Format a date value, returning "" for blank or invalid values
 */
function formatFollowupDateValue_(value, tz, pattern) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return isNaN(date.getTime()) ? "" : Utilities.formatDate(date, tz, pattern);
}

/**
 * Age text from DOB ("12 days", "5 months", "40 years")
 */
function calculateFollowupAge_(dob) {
  if (!dob) return "";
  const birthDate = new Date(dob);
  if (isNaN(birthDate.getTime())) return "";
  const diffInDays = Math.floor(
    (new Date().getTime() - birthDate.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (diffInDays < 30) return diffInDays + " days";
  if (diffInDays < 365) return Math.floor(diffInDays / 30) + " months";
  return Math.floor(diffInDays / 365) + " years";
}

/**
 * Build a lookup function: MRD -> patient fields for the followup sheet
 */
function buildFollowupPatientLookup_(patientMasterSheet, tz) {
  const data = patientMasterSheet.getDataRange().getValues();
  const headers = data[0] || [];
  const col = function (name, fallback) {
    const idx = headers.indexOf(name);
    return idx !== -1 ? idx : fallback;
  };
  const c = {
    mrd: col("MRDNo", 0),
    name: col("Name", 1),
    dob: col("DOB", 2),
    gender: col("Gender", 3),
    phone: col("Phone", 4),
    address: col("Address", 5),
    homeNo: col("HomeNo", 6),
    workNo: col("WorkNo", 7),
    registeredOn: col("RegisteredOn", 8),
    type: col("Type", 9),
    additionalInfo: col("AdditionalInfo", 10),
    status: col("Status", 11),
  };

  const rowByMrd = Object.create(null);
  for (let i = 1; i < data.length; i++) {
    const key = (data[i][c.mrd] || "").toString().trim().toUpperCase();
    if (key && rowByMrd[key] === undefined) rowByMrd[key] = i;
  }

  return function (mrdNo) {
    if (!mrdNo) return null;
    let key = mrdNo.toString().trim().toUpperCase();
    if (key.indexOf("SPD") !== 0) key = "SPD" + key;
    const i = rowByMrd[key];
    if (i === undefined) return null;

    const p = data[i];
    return {
      MRDNo: p[c.mrd],
      PatientName: p[c.name] || "",
      DOB: formatFollowupDateValue_(p[c.dob], tz, "yyyy-MM-dd"),
      Age: calculateFollowupAge_(p[c.dob]),
      Gender: p[c.gender] || "",
      Phone: p[c.phone] || "",
      Address: p[c.address] || "",
      HomeNo: p[c.homeNo] || "",
      WorkNo: p[c.workNo] || "",
      AdditionalInfo: p[c.additionalInfo] || "",
      Type: p[c.type] || "",
      Status: p[c.status] || "",
      RegisteredOn: formatFollowupDateValue_(
        p[c.registeredOn],
        tz,
        "yyyy-MM-dd HH:mm:ss",
      ),
    };
  };
}

/**
 * Build a followup-layout row (A-AL) from normalized source fields + patient data
 */
function buildFollowupRow_(fields, mrdNo, patientLookup, sourceCode) {
  const row = new Array(FOLLOWUP_ROW_WIDTH).fill("");
  FOLLOWUP_CORE_HEADERS.forEach(function (header, i) {
    row[i] = fields[header] !== undefined ? fields[header] : "";
  });

  const patient = patientLookup(mrdNo);
  if (patient) {
    FOLLOWUP_PATIENT_HEADERS.forEach(function (header, i) {
      row[FOLLOWUP_MRD_COL + i] = patient[header] || "";
    });
  } else {
    row[FOLLOWUP_MRD_COL] = mrdNo;
  }

  row[FOLLOWUP_EXTRA_START_COL] = sourceCode;
  FOLLOWUP_EXTRA_HEADERS.forEach(function (header, i) {
    if (i === 0) return; // Source
    row[FOLLOWUP_EXTRA_START_COL + i] =
      fields[header] !== undefined ? fields[header] : "";
  });
  return row;
}

/**
 * Which followup to keep when one patient has several on the same date: FM2 over FM1, then higher ID
 */
function compareFollowupSameDay_(a, b) {
  const rankA = a.source === "FM2" ? 2 : 1;
  const rankB = b.source === "FM2" ? 2 : 1;
  if (rankA !== rankB) return rankB - rankA;
  return b.numericId - a.numericId;
}

/**
 * Union of two tag lists, case-insensitive, keeping the first spelling seen
 */
function mergeFollowupTags_(tags, extraTags) {
  const seen = {};
  const merged = [];
  tags.concat(extraTags).forEach(function (tag) {
    const key = tag.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    merged.push(tag);
  });
  return merged;
}

/**
 * followupArchive row: followup columns A-AL + ArchiveReason + ArchivedOn
 */
function toFollowupArchiveRow_(row, reason, archivedOn) {
  const out = row.slice(0, FOLLOWUP_ROW_WIDTH);
  while (out.length < FOLLOWUP_ROW_WIDTH) out.push("");
  return out.concat([reason, archivedOn]);
}

/**
 * Replace all followup data rows. New rows are written over the old ones first and only the
 * leftover rows below are cleared, so the sheet is never left empty part-way.
 */
function writeFollowupRows_(sheet, rows) {
  const oldLastRow = sheet.getLastRow();
  if (rows.length > 0) {
    const extraRowsNeeded = rows.length + 1 - sheet.getMaxRows();
    if (extraRowsNeeded > 0) {
      sheet.insertRowsAfter(sheet.getMaxRows(), extraRowsNeeded);
    }
    sheet.getRange(2, 1, rows.length, FOLLOWUP_ROW_WIDTH).setValues(rows);
  }

  const firstLeftoverRow = rows.length + 2;
  if (oldLastRow >= firstLeftoverRow) {
    sheet
      .getRange(
        firstLeftoverRow,
        1,
        oldLastRow - firstLeftoverRow + 1,
        Math.max(sheet.getLastColumn(), FOLLOWUP_ROW_WIDTH),
      )
      .clearContent();
  }
}

/**
 * Append rows after the last row, adding sheet rows if needed
 */
function appendFollowupRows_(sheet, rows, width) {
  if (rows.length === 0) return;
  const startRow = sheet.getLastRow() + 1;
  const extraRowsNeeded = startRow + rows.length - 1 - sheet.getMaxRows();
  if (extraRowsNeeded > 0) {
    sheet.insertRowsAfter(sheet.getMaxRows(), extraRowsNeeded);
  }
  sheet.getRange(startRow, 1, rows.length, width).setValues(rows);
}

/**
 * Add system notes (e.g. "Merged from ...") to CommentsHistory
 * @param {Array<{id: string, text: string}>} notes
 */
function addFollowupSystemComments_(notes, addedAt) {
  if (notes.length === 0) return;
  const commentsSheet = initializeCommentsHistorySheet();
  const data = commentsSheet.getDataRange().getValues();
  const counts = {};
  for (let i = 1; i < data.length; i++) {
    const id = data[i][0] === null ? "" : data[i][0].toString();
    counts[id] = (counts[id] || 0) + 1;
  }
  const rows = notes.map(function (note) {
    counts[note.id] = (counts[note.id] || 0) + 1;
    return [note.id, note.text, "SYSTEM", addedAt, counts[note.id]];
  });
  appendFollowupRows_(commentsSheet, rows, 5);
}

/**
 * Diagnostic: explain where one patient's followups are and what the next sync will do with them.
 * Run from the editor, e.g. debugFollowupPatient("SPD00000"), and read the execution log.
 * Read-only - changes nothing.
 * @param {string|number} patientIdOrMrd - "SPD00000" or 12675
 */
function debugFollowupPatient(patientIdOrMrd) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = Session.getScriptTimeZone();
  const todayKey = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  const patientId = (patientIdOrMrd || "")
    .toString()
    .trim()
    .toUpperCase()
    .replace(/^SPD/, "");
  const mrdNo = "SPD" + patientId;

  const report = {
    mrdNo: mrdNo,
    today: todayKey,
    scriptTimeZone: tz,
    spreadsheetTimeZone: ss.getSpreadsheetTimeZone(),
    masterRows: [],
    inFollowup: [],
    inFollowupArchive: [],
    inPatientMaster: false,
    hasStaffComment: false,
  };

  const patientSheet = ss.getSheetByName("patientMaster");
  const patientLookup = patientSheet
    ? buildFollowupPatientLookup_(patientSheet, tz)
    : function () {
        return null;
      };
  report.inPatientMaster = patientLookup(mrdNo) !== null;

  const archiveSheet = ss.getSheetByName("followupArchive");
  const archiveState = archiveSheet
    ? readFollowupArchiveState_(archiveSheet, tz)
    : { keys: {}, sameDayLosers: {} };
  const handledIds = readHandledFollowupIds_(ss);
  const staffComments = readLatestStaffComments_(ss);

  // This patient's master rows and what the next sync does with each
  const candidates = [];
  FOLLOWUP_SOURCES.forEach(function (source) {
    const sheet = ss.getSheetByName(source.sheetName);
    if (!sheet) {
      report.masterRows.push({ sheet: source.sheetName, problem: "sheet not found - sync stops" });
      return;
    }
    const result = readFollowupSourceRows_(sheet, source, patientLookup, tz);
    if (result.error) {
      report.masterRows.push({ sheet: source.sheetName, problem: result.error + " - sync stops" });
      return;
    }
    result.records.forEach(function (rec) {
      if (rec.mrdKey !== mrdNo) return;
      const entry = {
        sheet: source.sheetName,
        id: rec.id,
        followUpDate: rec.dateKey || "(invalid/blank)",
      };
      if (rec.dateKey && rec.dateKey < todayKey) {
        entry.nextSync = "ignored: date is in the past";
      } else if (handledIds[rec.id]) {
        entry.nextSync = "ignored: already booked, cancelled or archived by staff";
      } else if (archiveState.sameDayLosers[rec.id + "|" + rec.dateKey]) {
        entry.nextSync = "ignored: archived earlier as a same-day duplicate";
      } else {
        entry.nextSync = "shown in followup";
        candidates.push({ rec: rec, entry: entry });
      }
      report.masterRows.push(entry);
    });
  });

  // Same-day duplicates among the rows that would be shown
  const byDate = {};
  candidates.forEach(function (c) {
    if (!c.rec.dateKey) return;
    if (!byDate[c.rec.dateKey]) byDate[c.rec.dateKey] = [];
    byDate[c.rec.dateKey].push(c);
  });
  Object.keys(byDate).forEach(function (dateKey) {
    const group = byDate[dateKey];
    if (group.length < 2) return;
    group.sort(function (a, b) {
      return compareFollowupSameDay_(a.rec, b.rec);
    });
    group.slice(1).forEach(function (c) {
      c.entry.nextSync =
        "archived as DUPLICATE_SAME_DAY (kept: " + group[0].rec.id + ")";
    });
  });

  candidates.forEach(function (c) {
    if (staffComments[c.rec.id] !== undefined) report.hasStaffComment = true;
  });

  ["followup", "followupArchive"].forEach(function (sheetName) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet || sheet.getLastRow() < 2) return;
    const width = Math.min(sheet.getLastColumn(), FOLLOWUP_ARCHIVE_ROW_WIDTH);
    sheet
      .getRange(2, 1, sheet.getLastRow() - 1, width)
      .getValues()
      .forEach(function (row, i) {
        if ((row[FOLLOWUP_MRD_COL] || "").toString().trim().toUpperCase() !== mrdNo) return;
        const entry = {
          sheetRow: i + 2,
          id: row[0],
          followUpDate: getFollowupDateKey_(row[FOLLOWUP_DATE_COL], tz),
          source: row[FOLLOWUP_EXTRA_START_COL] || getFollowupSourceFromId_(row[0]),
        };
        if (sheetName === "followupArchive") {
          entry.reason = row[FOLLOWUP_ROW_WIDTH] || "(archived by old sync)";
          entry.archivedOn = row[FOLLOWUP_ROW_WIDTH + 1] || "";
          report.inFollowupArchive.push(entry);
        } else {
          report.inFollowup.push(entry);
        }
      });
  });

  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/**
 * Install a daily time-driven trigger to run syncFollowups()
 * Checks for existing triggers to avoid duplicates
 */
function installFollowupTrigger() {
  try {
    // Get all existing triggers
    const existingTriggers = ScriptApp.getProjectTriggers();

    // Check if trigger already exists
    let triggerExists = false;
    for (let i = 0; i < existingTriggers.length; i++) {
      if (existingTriggers[i].getHandlerFunction() === "syncFollowups") {
        triggerExists = true;
        break;
      }
    }

    if (triggerExists) {
      return { success: true, message: "Trigger already exists" };
    }

    // Create a new daily trigger to run at 2 AM (adjust time as needed)
    ScriptApp.newTrigger("syncFollowups")
      .timeBased()
      .atHour(2)
      .everyDays(1)
      .create();

    return { success: true, message: "Trigger created successfully" };
  } catch (e) {
    return {
      success: false,
      message: "Error installing trigger: " + e.toString(),
    };
  }
}

/**
 * Search followup appointments from the followup sheet
 * Filters by MRD number, patient name, phone number, date range, etc.
 * Returns all followups if search parameters are empty
 * @param {Object} searchParams - Search parameters
 * @param {string} searchParams.mrdNo - MRD number to search for
 * @param {string} searchParams.patientName - Patient name to search for
 * @param {string} searchParams.phone - Phone number to search for
 * @param {string} searchParams.fromDate - Start date for date range filter (YYYY-MM-DD)
 * @param {string} searchParams.toDate - End date for date range filter (YYYY-MM-DD)
 * @return {Object} Search results with followups array
 */
function searchFollowupJS(searchParams) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const followupSheet = ss.getSheetByName("followup");

    if (!followupSheet) {
      return {
        success: false,
        message: "Followup sheet not found. Please run syncFollowups first.",
      };
    }

    // Get all data from followup sheet
    const data = followupSheet.getDataRange().getValues();
    if (data.length <= 1) {
      return {
        success: true,
        followups: [],
        message: "No followup data available",
      };
    }

    const headers = data[0];

    // Find column indices
    const aFollowIDColIndex = headers.indexOf("aFollowID");
    const mrdColIndex = headers.indexOf("MRDNo");
    const patientNameColIndex = headers.indexOf("PatientName");
    const phoneColIndex = headers.indexOf("Phone");
    const ageColIndex = headers.indexOf("Age");
    const genderColIndex = headers.indexOf("Gender");
    const followupDateColIndex = headers.indexOf("follow_up_date");
    const commentsColIndex = headers.indexOf("comments");
    const homeNoColIndex = headers.indexOf("HomeNo");
    const workNoColIndex = headers.indexOf("WorkNo");
    const typeColIndex = headers.indexOf("Type");
    const registeredOnColIndex = headers.indexOf("RegisteredOn");
    const sourceColIndex = headers.indexOf("Source");
    const specializationColIndex = headers.indexOf("SpecializationName");
    const categoryColIndex = headers.indexOf("CategoryName");
    const TAG_COLUMN_INDEX = 31; // Column AF (index 31)

    // Validate required columns exist
    if (
      mrdColIndex === -1 ||
      patientNameColIndex === -1 ||
      phoneColIndex === -1
    ) {
      return {
        success: false,
        message:
          "Followup sheet structure is invalid. Please check column headers.",
      };
    }

    // Followups per MRD across the whole sheet (for the "Duplicate" badge)
    const followupCountByMrd = {};
    for (let i = 1; i < data.length; i++) {
      const rowMrd = (data[i][mrdColIndex] || "").toString().trim().toUpperCase();
      if (rowMrd) followupCountByMrd[rowMrd] = (followupCountByMrd[rowMrd] || 0) + 1;
    }

    // Normalize search parameters
    let mrdNo = (searchParams.mrdNo || "").toString().trim().toUpperCase();
    const patientName = (searchParams.patientName || "")
      .toString()
      .trim()
      .toLowerCase();
    const phone = (searchParams.phone || "").toString().trim();
    const remarks = (searchParams.remarks || "")
      .toString()
      .trim()
      .toLowerCase();
    const fromDate = (searchParams.fromDate || "").toString().trim();
    const toDate = (searchParams.toDate || "").toString().trim();
    const tag = (searchParams.tag || "").toString().trim();
    const specialization = (searchParams.specialization || "")
      .toString()
      .trim()
      .toLowerCase();
    const category = (searchParams.category || "")
      .toString()
      .trim()
      .toLowerCase();

    // Normalize MRD number: if it's just a number, add SPD prefix
    // If it starts with SPD, keep it; otherwise add SPD
    if (mrdNo) {
      if (/^\d+$/.test(mrdNo)) {
        // It's just a number, add SPD prefix
        mrdNo = "SPD" + mrdNo;
      } else if (!mrdNo.startsWith("SPD")) {
        // It has non-numeric characters but doesn't start with SPD
        // Try to extract number and add SPD
        const numMatch = mrdNo.match(/\d+/);
        if (numMatch) {
          mrdNo = "SPD" + numMatch[0];
        }
      }
    }

    // Filter data based on search parameters
    // If all parameters are empty, return all records
    const filteredData = data.slice(1).filter(function (row) {
      // If all search params are empty, include all rows
      if (
        !mrdNo &&
        !patientName &&
        !phone &&
        !remarks &&
        !fromDate &&
        !toDate &&
        !tag &&
        !specialization &&
        !category
      ) {
        return true;
      }

      // Check specialization / category match (exact, case-insensitive)
      if (specialization) {
        const rowSpecialization =
          specializationColIndex !== -1
            ? (row[specializationColIndex] || "").toString().trim().toLowerCase()
            : "";
        if (rowSpecialization !== specialization) {
          return false;
        }
      }
      if (category) {
        const rowCategory =
          categoryColIndex !== -1
            ? (row[categoryColIndex] || "").toString().trim().toLowerCase()
            : "";
        if (rowCategory !== category) {
          return false;
        }
      }

      // Check date range if fromDate or toDate is provided
      if (fromDate || toDate) {
        const rowDate = row[followupDateColIndex];
        if (rowDate) {
          const rowDateStr = Utilities.formatDate(
            new Date(rowDate),
            Session.getScriptTimeZone(),
            "yyyy-MM-dd",
          );

          // If only fromDate is provided, check if rowDate >= fromDate
          if (fromDate && !toDate) {
            if (rowDateStr < fromDate) {
              return false;
            }
          }
          // If only toDate is provided, check if rowDate <= toDate
          else if (!fromDate && toDate) {
            if (rowDateStr > toDate) {
              return false;
            }
          }
          // If both fromDate and toDate are provided, check if rowDate is within range
          else if (fromDate && toDate) {
            if (rowDateStr < fromDate || rowDateStr > toDate) {
              return false;
            }
          }
        } else {
          return false; // No date in row, exclude if date filter is provided
        }
      }

      // Check MRD match - exact match only
      if (mrdNo) {
        const rowMRD = (row[mrdColIndex] || "").toString().trim().toUpperCase();
        // Use exact match instead of includes
        if (rowMRD !== mrdNo) {
          return false;
        }
      }

      // Check patient name match
      if (patientName) {
        const rowName = (row[patientNameColIndex] || "")
          .toString()
          .trim()
          .toLowerCase();
        if (!rowName.includes(patientName)) {
          return false;
        }
      }

      // Check phone match - search in Phone, HomeNo, and WorkNo columns
      if (phone) {
        const rowPhone = (row[phoneColIndex] || "").toString().trim();
        const rowHomeNo =
          homeNoColIndex !== -1
            ? (row[homeNoColIndex] || "").toString().trim()
            : "";
        const rowWorkNo =
          workNoColIndex !== -1
            ? (row[workNoColIndex] || "").toString().trim()
            : "";

        // Check if phone number is found in any of the three columns
        const phoneMatch = rowPhone.includes(phone);
        const homeNoMatch = rowHomeNo.includes(phone);
        const workNoMatch = rowWorkNo.includes(phone);

        if (!phoneMatch && !homeNoMatch && !workNoMatch) {
          return false;
        }
      }

      // Check remarks match - search in column G (Comments column, index 6)
      if (remarks) {
        const rowRemarks = (row[commentsColIndex] || "")
          .toString()
          .trim()
          .toLowerCase();
        if (!rowRemarks.includes(remarks)) {
          return false;
        }
      }

      // Check tag match
      if (tag) {
        const tagString = row[TAG_COLUMN_INDEX] || "";
        const tags = parseTagString(tagString);

        // Check if the selected tag exists in the followup's tags (case-sensitive exact match)
        if (!tags.includes(tag)) {
          return false;
        }
      }

      return true;
    });

    // Format results
    const followups = filteredData.map(function (row) {
      // Helper function to format date
      function formatDate(dateValue) {
        if (!dateValue) return "";
        if (dateValue instanceof Date) {
          return Utilities.formatDate(
            dateValue,
            Session.getScriptTimeZone(),
            "yyyy-MM-dd",
          );
        }
        return dateValue.toString();
      }

      // Helper function to format datetime
      function formatDateTime(dateValue) {
        if (!dateValue) return "";
        if (dateValue instanceof Date) {
          return Utilities.formatDate(
            dateValue,
            Session.getScriptTimeZone(),
            "yyyy-MM-dd HH:mm:ss",
          );
        }
        return dateValue.toString();
      }

      return {
        aFollowID: row[aFollowIDColIndex] || "",
        MRDNo: row[mrdColIndex] || "",
        PatientName: row[patientNameColIndex] || "",
        Age: row[ageColIndex] || "",
        Gender: row[genderColIndex] || "",
        Phone: row[phoneColIndex] || "",
        HomeNo: homeNoColIndex !== -1 ? row[homeNoColIndex] || "" : "",
        WorkNo: workNoColIndex !== -1 ? row[workNoColIndex] || "" : "",
        Type: typeColIndex !== -1 ? row[typeColIndex] || "" : "",
        FollowupDate: formatDate(row[followupDateColIndex]),
        Comments: row[commentsColIndex] || "",
        RegisteredOn: formatDateTime(row[registeredOnColIndex]),
        Tag: parseTagString(row[TAG_COLUMN_INDEX] || ""),
        Source:
          sourceColIndex !== -1
            ? row[sourceColIndex] || getFollowupSourceFromId_(row[aFollowIDColIndex])
            : getFollowupSourceFromId_(row[aFollowIDColIndex]),
        SpecializationName:
          specializationColIndex !== -1 ? row[specializationColIndex] || "" : "",
        CategoryName: categoryColIndex !== -1 ? row[categoryColIndex] || "" : "",
        DuplicateCount:
          followupCountByMrd[(row[mrdColIndex] || "").toString().trim().toUpperCase()] || 1,
      };
    });

    return {
      success: true,
      followups: followups,
      total: followups.length,
    };
  } catch (e) {
    return {
      success: false,
      message: "Error searching followups: " + e.toString(),
    };
  }
}

/**
 * Get followup appointments with duplicate MRD numbers
 * @return {Object} Success status and list of followups with duplicate MRDs
 */
function getDuplicateFollowups() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const followupSheet = ss.getSheetByName("followup");

    if (!followupSheet) {
      return { success: false, message: "Followup sheet not found" };
    }

    const data = followupSheet.getDataRange().getValues();
    if (data.length <= 1) {
      return { success: false, message: "No followup data available" };
    }

    const headers = data[0];
    const mrdColIndex = headers.indexOf("MRDNo");
    const aFollowIDColIndex = headers.indexOf("aFollowID");
    const patientNameColIndex = headers.indexOf("PatientName");
    const phoneColIndex = headers.indexOf("Phone");
    const ageColIndex = headers.indexOf("Age");
    const genderColIndex = headers.indexOf("Gender");
    const followupDateColIndex = headers.indexOf("follow_up_date");
    const commentsColIndex = headers.indexOf("comments");
    const homeNoColIndex = headers.indexOf("HomeNo");
    const workNoColIndex = headers.indexOf("WorkNo");
    const typeColIndex = headers.indexOf("Type");
    const registeredOnColIndex = headers.indexOf("RegisteredOn");
    const sourceColIndex = headers.indexOf("Source");
    const specializationColIndex = headers.indexOf("SpecializationName");
    const categoryColIndex = headers.indexOf("CategoryName");
    const TAG_COLUMN_INDEX = 31; // Column AF (index 31)

    if (mrdColIndex === -1) {
      return { success: false, message: "MRDNo column not found" };
    }

    // 1. Count occurrences
    const counts = {};
    for (let i = 1; i < data.length; i++) {
      const mrd = data[i][mrdColIndex];
      if (mrd) {
        const mrdStr = mrd.toString().trim();
        counts[mrdStr] = (counts[mrdStr] || 0) + 1;
      }
    }

    const duplicates = Object.keys(counts).filter((m) => counts[m] > 1);
    if (duplicates.length === 0) {
      return {
        success: false,
        message: "No MRD with multiple followup appointments",
      };
    }

    // Helper function to format date
    function formatDate(dateValue) {
      if (!dateValue) return "";
      if (dateValue instanceof Date) {
        return Utilities.formatDate(
          dateValue,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd",
        );
      }
      return dateValue.toString();
    }

    // Helper function to format datetime
    function formatDateTime(dateValue) {
      if (!dateValue) return "";
      if (dateValue instanceof Date) {
        return Utilities.formatDate(
          dateValue,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd HH:mm:ss",
        );
      }
      return dateValue.toString();
    }

    // 2. Build followup objects for duplicates
    const followups = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const rowMRD = (row[mrdColIndex] || "").toString().trim();

      if (duplicates.includes(rowMRD)) {
        try {
          followups.push({
            aFollowID: row[aFollowIDColIndex] || "",
            MRDNo: rowMRD,
            PatientName: row[patientNameColIndex] || "",
            Age: row[ageColIndex] || "",
            Gender: row[genderColIndex] || "",
            Phone: row[phoneColIndex] || "",
            HomeNo: homeNoColIndex !== -1 ? row[homeNoColIndex] || "" : "",
            WorkNo: workNoColIndex !== -1 ? row[workNoColIndex] || "" : "",
            Type: typeColIndex !== -1 ? row[typeColIndex] || "" : "",
            FollowupDate: formatDate(row[followupDateColIndex]),
            Comments: row[commentsColIndex] || "",
            RegisteredOn: formatDateTime(row[registeredOnColIndex]),
            Tag: parseTagString(row[TAG_COLUMN_INDEX] || ""),
            Source:
              sourceColIndex !== -1
                ? row[sourceColIndex] || getFollowupSourceFromId_(row[aFollowIDColIndex])
                : getFollowupSourceFromId_(row[aFollowIDColIndex]),
            SpecializationName:
              specializationColIndex !== -1 ? row[specializationColIndex] || "" : "",
            CategoryName: categoryColIndex !== -1 ? row[categoryColIndex] || "" : "",
            DuplicateCount: counts[rowMRD] || 1,
          });
        } catch (e) {
          // Log the error for this specific row but continue processing
          continue;
        }
      }
    }

    // 3. Sort by MRD, then by followup date
    followups.sort((a, b) => {
      if (a.MRDNo !== b.MRDNo) {
        return a.MRDNo.localeCompare(b.MRDNo);
      }
      // For same MRD, sort by followup date
      if (a.FollowupDate !== b.FollowupDate) {
        return a.FollowupDate.localeCompare(b.FollowupDate);
      }
      return 0;
    });

    return { success: true, followups: followups, total: followups.length };
  } catch (e) {
    return {
      success: false,
      message: "Error retrieving duplicate followups: " + e.toString(),
    };
  }
}

/**
 * Search past followups in the followupArchive sheet (read-only view for the Followup page).
 * Needs at least an MRD number, patient name or phone number, so the whole archive is never returned.
 * Columns are read by position: older archive rows were saved under out-of-date headers.
 * @param {Object} searchParams - same shape as searchFollowupJS
 * @return {Object} { success, followups, total, shown }
 */
function searchFollowupArchiveJS(searchParams) {
  try {
    const MAX_RESULTS = 200;
    searchParams = searchParams || {};

    let mrdNo = (searchParams.mrdNo || "").toString().trim().toUpperCase();
    const patientName = (searchParams.patientName || "").toString().trim().toLowerCase();
    const phone = (searchParams.phone || "").toString().trim();
    const remarks = (searchParams.remarks || "").toString().trim().toLowerCase();
    const tag = (searchParams.tag || "").toString().trim();
    const specialization = (searchParams.specialization || "").toString().trim().toLowerCase();
    const category = (searchParams.category || "").toString().trim().toLowerCase();
    const fromDate = (searchParams.fromDate || "").toString().trim();
    const toDate = (searchParams.toDate || "").toString().trim();

    if (!mrdNo && !patientName && !phone) {
      return {
        success: false,
        message: "Search by MRD number, patient name or phone number to see past followups.",
      };
    }

    // Same MRD normalisation as searchFollowupJS
    if (mrdNo) {
      if (/^\d+$/.test(mrdNo)) {
        mrdNo = "SPD" + mrdNo;
      } else if (!mrdNo.startsWith("SPD")) {
        const numMatch = mrdNo.match(/\d+/);
        if (numMatch) mrdNo = "SPD" + numMatch[0];
      }
    }

    const archiveSheet =
      SpreadsheetApp.getActiveSpreadsheet().getSheetByName("followupArchive");
    if (!archiveSheet || archiveSheet.getLastRow() < 2) {
      return { success: true, followups: [], total: 0, shown: 0 };
    }

    const tz = Session.getScriptTimeZone();
    const width = Math.min(archiveSheet.getLastColumn(), FOLLOWUP_ARCHIVE_ROW_WIDTH);
    const cell = function (row, index) {
      return index < row.length && row[index] !== null ? row[index] : "";
    };
    const PHONE_COL = FOLLOWUP_MRD_COL + FOLLOWUP_PATIENT_HEADERS.indexOf("Phone");
    const NAME_COL = FOLLOWUP_MRD_COL + FOLLOWUP_PATIENT_HEADERS.indexOf("PatientName");
    const AGE_COL = FOLLOWUP_MRD_COL + FOLLOWUP_PATIENT_HEADERS.indexOf("Age");
    const GENDER_COL = FOLLOWUP_MRD_COL + FOLLOWUP_PATIENT_HEADERS.indexOf("Gender");
    const SPECIALIZATION_COL =
      FOLLOWUP_EXTRA_START_COL + FOLLOWUP_EXTRA_HEADERS.indexOf("SpecializationName");
    const CATEGORY_COL =
      FOLLOWUP_EXTRA_START_COL + FOLLOWUP_EXTRA_HEADERS.indexOf("CategoryName");

    const matches = [];
    archiveSheet
      .getRange(2, 1, archiveSheet.getLastRow() - 1, width)
      .getValues()
      .forEach(function (row) {
        if (cell(row, 0) === "") return;

        if (mrdNo && cell(row, FOLLOWUP_MRD_COL).toString().trim().toUpperCase() !== mrdNo) {
          return;
        }
        if (
          patientName &&
          !cell(row, NAME_COL).toString().toLowerCase().includes(patientName)
        ) {
          return;
        }
        if (phone && !cell(row, PHONE_COL).toString().includes(phone)) return;
        if (
          remarks &&
          !cell(row, FOLLOWUP_COMMENTS_COL).toString().toLowerCase().includes(remarks)
        ) {
          return;
        }
        const tags = parseTagString(cell(row, FOLLOWUP_TAG_COL));
        if (tag && !tags.includes(tag)) return;
        if (
          specialization &&
          cell(row, SPECIALIZATION_COL).toString().trim().toLowerCase() !== specialization
        ) {
          return;
        }
        if (
          category &&
          cell(row, CATEGORY_COL).toString().trim().toLowerCase() !== category
        ) {
          return;
        }

        const dateKey = getFollowupDateKey_(cell(row, FOLLOWUP_DATE_COL), tz);
        if (fromDate && (!dateKey || dateKey < fromDate)) return;
        if (toDate && (!dateKey || dateKey > toDate)) return;

        matches.push({
          aFollowID: normalizeFollowupId_(cell(row, 0)),
          MRDNo: cell(row, FOLLOWUP_MRD_COL).toString(),
          PatientName: cell(row, NAME_COL).toString(),
          Age: cell(row, AGE_COL).toString(),
          Gender: cell(row, GENDER_COL).toString(),
          Phone: cell(row, PHONE_COL).toString(),
          FollowupDate: dateKey,
          Comments: cell(row, FOLLOWUP_COMMENTS_COL).toString(),
          Tag: tags,
          Source:
            cell(row, FOLLOWUP_EXTRA_START_COL).toString() ||
            getFollowupSourceFromId_(cell(row, 0)),
          SpecializationName: cell(row, SPECIALIZATION_COL).toString(),
          CategoryName: cell(row, CATEGORY_COL).toString(),
          ArchiveReason: cell(row, FOLLOWUP_ROW_WIDTH).toString(),
          ArchivedOn: formatFollowupDateValue_(
            cell(row, FOLLOWUP_ROW_WIDTH + 1),
            tz,
            "yyyy-MM-dd HH:mm:ss",
          ),
        });
      });

    // Newest follow-up date first
    matches.sort(function (a, b) {
      if (a.FollowupDate !== b.FollowupDate) {
        return a.FollowupDate < b.FollowupDate ? 1 : -1;
      }
      return a.ArchivedOn < b.ArchivedOn ? 1 : a.ArchivedOn > b.ArchivedOn ? -1 : 0;
    });

    return {
      success: true,
      followups: matches.slice(0, MAX_RESULTS),
      total: matches.length,
      shown: Math.min(matches.length, MAX_RESULTS),
    };
  } catch (e) {
    return {
      success: false,
      message: "Error searching past followups: " + e.toString(),
    };
  }
}

/**
 * Get distinct specialization and category names in the followup sheet (for the page filters)
 * @return {Object} { success, specializations: string[], categories: string[] }
 */
function getFollowupFilterOptions() {
  try {
    const followupSheet =
      SpreadsheetApp.getActiveSpreadsheet().getSheetByName("followup");
    if (!followupSheet || followupSheet.getLastRow() < 2) {
      return { success: true, specializations: [], categories: [] };
    }

    const data = followupSheet.getDataRange().getValues();
    const headers = data[0];

    function distinctValues(colIndex) {
      if (colIndex === -1) return [];
      const seen = {};
      for (let i = 1; i < data.length; i++) {
        const value = (data[i][colIndex] || "").toString().trim();
        if (value) seen[value] = true;
      }
      return Object.keys(seen).sort();
    }

    return {
      success: true,
      specializations: distinctValues(headers.indexOf("SpecializationName")),
      categories: distinctValues(headers.indexOf("CategoryName")),
    };
  } catch (e) {
    return {
      success: false,
      message: "Error loading followup filter options: " + e.toString(),
      specializations: [],
      categories: [],
    };
  }
}

/**
 * Cancel a followup - moves from followup sheet to cancel sheet
 * @param {string} aFollowID - The followup ID to cancel
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Success/failure response
 */
function cancelFollowup(aFollowID, sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const followupSheet = ss.getSheetByName("followup");
    const cancelSheet = ss.getSheetByName("cancel");

    if (!followupSheet) {
      return { success: false, message: "Followup sheet not found" };
    }

    if (!cancelSheet) {
      return { success: false, message: "Cancel sheet not found" };
    }

    // Get followup data
    const followupData = followupSheet.getDataRange().getValues();
    const followupHeaders = followupData[0];

    // Find column indices in followup sheet
    const aFollowIDColIndex = followupHeaders.indexOf("aFollowID");
    const mrdColIndex = followupHeaders.indexOf("MRDNo");
    const patientNameColIndex = followupHeaders.indexOf("PatientName");
    const ageColIndex = followupHeaders.indexOf("Age");
    const genderColIndex = followupHeaders.indexOf("Gender");
    const phoneColIndex = followupHeaders.indexOf("Phone");
    const homeNoColIndex = followupHeaders.indexOf("HomeNo");
    const workNoColIndex = followupHeaders.indexOf("WorkNo");
    const typeColIndex = followupHeaders.indexOf("Type");
    const followUpDateColIndex = followupHeaders.indexOf("follow_up_date");
    const commentsColIndex = followupHeaders.indexOf("comments");

    if (aFollowIDColIndex === -1) {
      return {
        success: false,
        message: "aFollowID column not found in followup sheet",
      };
    }

    // Find the followup row
    let followupRowIndex = -1;
    let followupRow = null;
    for (let i = 1; i < followupData.length; i++) {
      if (
        followupData[i][aFollowIDColIndex] &&
        followupData[i][aFollowIDColIndex].toString() === aFollowID.toString()
      ) {
        followupRowIndex = i;
        followupRow = followupData[i];
        break;
      }
    }

    if (followupRowIndex === -1 || !followupRow) {
      return {
        success: false,
        message: "Followup not found with aFollowID: " + aFollowID,
      };
    }

    // Get username
    const username = getSessionUsername(sessionToken);
    const now = new Date();

    // Auto-generate AppointmentID for cancel sheet (format: FU_yyyyMMdd_HHmmss)
    const appointmentID =
      "FU_" +
      Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyyMMdd_HHmmss");

    // Ensure journey column exists in cancel sheet
    const cancelJourneyColIndex = ensureJourneyColumn(cancelSheet);

    // Create journey entry for AppointmentJourney (Column AJ)
    const journeyEntry = {
      timestamp: now.toISOString(),
      action: "cancelled",
      by: username,
      fromSheet: "followup",
      toSheet: "cancel",
      description: "Followup cancelled and moved to cancel sheet",
      aFollowID: aFollowID,
      followUpDate: followupRow[followUpDateColIndex] || "",
    };

    // Build cancel row with at least 36 columns
    const cancelRow = new Array(36).fill("");

    cancelRow[0] = appointmentID; // Column A - AppointmentID (auto-generated)
    cancelRow[1] = followupRow[followUpDateColIndex] || ""; // Column B - AppointmentDate (use follow_up_date)
    cancelRow[2] = ""; // Column C - TimeSlot
    cancelRow[3] = followupRow[mrdColIndex] || ""; // Column D - MRDNo
    cancelRow[4] = followupRow[patientNameColIndex] || ""; // Column E - PatientName
    cancelRow[5] = followupRow[ageColIndex] || ""; // Column F - Age
    cancelRow[6] = followupRow[genderColIndex] || ""; // Column G - Gender
    cancelRow[7] = followupRow[phoneColIndex] || ""; // Column H - Phone
    cancelRow[8] = "Followup"; // Column I - AppointmentType
    cancelRow[9] = ""; // Column J - Doctor
    cancelRow[10] = ""; // Column K - PlanOfAction
    cancelRow[11] = followupRow[commentsColIndex] || ""; // Column L - Remarks (use comments)
    cancelRow[12] = ""; // Column M - BookedBy
    cancelRow[13] = ""; // Column N - BookingDate
    cancelRow[21] = now; // Column V - DeletedOn
    cancelRow[22] = username; // Column W - DeletedBy
    cancelRow[30] = aFollowID; // Column AE - aFollowID
    if (cancelJourneyColIndex !== -1) {
      cancelRow[cancelJourneyColIndex] = JSON.stringify([journeyEntry]); // Column AJ - AppointmentJourney
    }

    // Append to cancel sheet
    cancelSheet.appendRow(cancelRow);

    // Delete from followup sheet (row index + 1 for 1-based sheet rows)
    followupSheet.deleteRow(followupRowIndex + 1);

    // Log audit event
    logAuditEvent(sessionToken, "CANCEL_FOLLOWUP", "FOLLOWUP", aFollowID, {
      sheetName: "followup",
      movedToSheet: "cancel",
      newAppointmentID: appointmentID,
      mrdNo: followupRow[mrdColIndex] || "",
      patientName: followupRow[patientNameColIndex] || "",
      followUpDate: followupRow[followUpDateColIndex] || "",
      cancelledBy: username,
    });

    return {
      success: true,
      message: "Followup cancelled successfully",
      appointmentID: appointmentID,
    };
  } catch (e) {
    return {
      success: false,
      message: "Error cancelling followup: " + e.toString(),
    };
  }
}

/**
 * Archive a followup - moves from followup sheet to Archive sheet
 * @param {string} aFollowID - The followup ID to archive
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Success/failure response
 */
function archiveFollowup(aFollowID, sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const followupSheet = ss.getSheetByName("followup");
    const archiveSheet = ss.getSheetByName("Archive");

    if (!followupSheet) {
      return { success: false, message: "Followup sheet not found" };
    }

    if (!archiveSheet) {
      return { success: false, message: "Archive sheet not found" };
    }

    // Get followup data
    const followupData = followupSheet.getDataRange().getValues();
    const followupHeaders = followupData[0];

    // Find column indices in followup sheet
    const aFollowIDColIndex = followupHeaders.indexOf("aFollowID");
    const mrdColIndex = followupHeaders.indexOf("MRDNo");
    const patientNameColIndex = followupHeaders.indexOf("PatientName");
    const ageColIndex = followupHeaders.indexOf("Age");
    const genderColIndex = followupHeaders.indexOf("Gender");
    const phoneColIndex = followupHeaders.indexOf("Phone");
    const homeNoColIndex = followupHeaders.indexOf("HomeNo");
    const workNoColIndex = followupHeaders.indexOf("WorkNo");
    const typeColIndex = followupHeaders.indexOf("Type");
    const followUpDateColIndex = followupHeaders.indexOf("follow_up_date");
    const commentsColIndex = followupHeaders.indexOf("comments");

    if (aFollowIDColIndex === -1) {
      return {
        success: false,
        message: "aFollowID column not found in followup sheet",
      };
    }

    // Find the followup row
    let followupRowIndex = -1;
    let followupRow = null;
    for (let i = 1; i < followupData.length; i++) {
      if (
        followupData[i][aFollowIDColIndex] &&
        followupData[i][aFollowIDColIndex].toString() === aFollowID.toString()
      ) {
        followupRowIndex = i;
        followupRow = followupData[i];
        break;
      }
    }

    if (followupRowIndex === -1 || !followupRow) {
      return {
        success: false,
        message: "Followup not found with aFollowID: " + aFollowID,
      };
    }

    // Get username
    const username = getSessionUsername(sessionToken);
    const now = new Date();

    // Auto-generate AppointmentID for Archive sheet (format: AFU_yyyyMMdd_HHmmss)
    // AFU = Archived FollowUp to distinguish from cancelled followups (FU_)
    const appointmentID =
      "AFU_" +
      Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyyMMdd_HHmmss");

    // Ensure journey column exists in Archive sheet
    const archiveJourneyColIndex = ensureJourneyColumn(archiveSheet);

    // Create journey entry for AppointmentJourney (Column AJ)
    const journeyEntry = {
      timestamp: now.toISOString(),
      action: "archived",
      by: username,
      fromSheet: "followup",
      toSheet: "Archive",
      description: "Followup archived",
      aFollowID: aFollowID,
      followUpDate: followupRow[followUpDateColIndex] || "",
    };

    // Build archive row with at least 36 columns
    // Archive sheet columns similar to cancel but with ArchivedDate (X) and ArchivedBy (Y) instead
    const archiveRow = new Array(36).fill("");

    archiveRow[0] = appointmentID; // Column A - AppointmentID (auto-generated for followup archives)
    archiveRow[1] = followupRow[followUpDateColIndex] || ""; // Column B - AppointmentDate (use follow_up_date)
    archiveRow[2] = ""; // Column C - TimeSlot
    archiveRow[3] = followupRow[mrdColIndex] || ""; // Column D - MRDNo
    archiveRow[4] = followupRow[patientNameColIndex] || ""; // Column E - PatientName
    archiveRow[5] = followupRow[ageColIndex] || ""; // Column F - Age
    archiveRow[6] = followupRow[genderColIndex] || ""; // Column G - Gender
    archiveRow[7] = followupRow[phoneColIndex] || ""; // Column H - Phone
    archiveRow[8] = "Followup"; // Column I - AppointmentType
    archiveRow[9] = ""; // Column J - Doctor
    archiveRow[10] = ""; // Column K - PlanOfAction
    archiveRow[11] = followupRow[commentsColIndex] || ""; // Column L - Remarks (use comments)
    archiveRow[12] = ""; // Column M - BookedBy
    archiveRow[13] = ""; // Column N - BookingDate
    archiveRow[23] = now; // Column X - ArchivedDate
    archiveRow[24] = username; // Column Y - ArchivedBy
    archiveRow[30] = aFollowID; // Column AE - aFollowID
    if (archiveJourneyColIndex !== -1) {
      archiveRow[archiveJourneyColIndex] = JSON.stringify([journeyEntry]); // Column AJ - AppointmentJourney
    }

    // Append to archive sheet
    archiveSheet.appendRow(archiveRow);

    // Delete from followup sheet (row index + 1 for 1-based sheet rows)
    followupSheet.deleteRow(followupRowIndex + 1);

    // Log audit event
    logAuditEvent(sessionToken, "ARCHIVE_FOLLOWUP", "FOLLOWUP", aFollowID, {
      sheetName: "followup",
      movedToSheet: "Archive",
      newAppointmentID: appointmentID,
      mrdNo: followupRow[mrdColIndex] || "",
      patientName: followupRow[patientNameColIndex] || "",
      followUpDate: followupRow[followUpDateColIndex] || "",
      archivedBy: username,
    });

    return {
      success: true,
      message: "Followup archived successfully",
      appointmentID: appointmentID,
    };
  } catch (e) {
    return {
      success: false,
      message: "Error archiving followup: " + e.toString(),
    };
  }
}

// ============================================
// DIRECT CALL FUNCTIONS
// ============================================

/**
 * Create a new direct call entry
 * @param {Object} data - Direct call data
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Success/failure response
 */
function createDirectCall(data, sessionToken) {
  try {
    // Validate session and check Level 4 constraints
    const session = getUserSession(sessionToken);
    if (!session) {
      return {
        success: false,
        message: "Session expired or invalid. Please login again.",
      };
    }
    const userLevel = getUserAccessLevel(session.role);
    if (userLevel === 4 && data.patientType === "Old") {
      return {
        success: false,
        message: "Level 4 login access is not permitted to book Old Patients. Only New Patients can be booked.",
      };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let directCallSheet = ss.getSheetByName("directCall");

    // Create sheet if it doesn't exist
    if (!directCallSheet) {
      directCallSheet = ss.insertSheet("directCall");
      // Add headers
      const headers = [
        "DirectCallID",
        "MRDNo",
        "PatientName",
        "Age",
        "Gender",
        "Phone",
        "PatientType",
        "CallType",
        "CaseType",
        "Urgency",
        "Remarks",
        "CreatedBy",
        "CreatedOn",
        "Status",
      ];
      directCallSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      directCallSheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
    }

    // Get username from session
    const username = getSessionUsername(sessionToken);
    const now = new Date();

    // Generate DirectCallID (format: DC_yyyyMMdd_HHmmss_xxx)
    const timestamp = Utilities.formatDate(
      now,
      Session.getScriptTimeZone(),
      "yyyyMMdd_HHmmss",
    );
    const random = Math.floor(Math.random() * 1000)
      .toString()
      .padStart(3, "0");
    const directCallID = "DC_" + timestamp + "_" + random;

    // Format date for display
    const createdOn = Utilities.formatDate(
      now,
      Session.getScriptTimeZone(),
      "yyyy-MM-dd HH:mm:ss",
    );

    // Handle MRD number
    let mrdNo = data.mrdNo || "";

    // Auto-generate MRD for NEW PATIENT: DirectCallID with "N" prefix
    if (data.patientType === "New" && !mrdNo) {
      mrdNo = "N" + directCallID; // This will give "NDC_yyyyMMdd_HHmmss_xxx"
    }
    // Normalize MRD number if provided (for existing patients)
    else if (mrdNo && /^\d+$/.test(mrdNo)) {
      mrdNo = "SPD" + mrdNo;
    } else if (mrdNo && /^SPD/i.test(mrdNo)) {
      mrdNo = "SPD" + mrdNo.replace(/^SPD/i, "");
    }

    // Build row
    const newRow = [
      directCallID,
      mrdNo,
      data.patientName || "",
      data.age || "",
      data.gender || "",
      data.phone || "",
      data.patientType || "",
      data.callType || "",
      data.caseType || "",
      data.urgency || "",
      data.remarks || "",
      username || "",
      createdOn,
      "Active",
    ];

    // Append row
    directCallSheet.appendRow(newRow);

    // Log audit event for direct call creation
    try {
      logAuditEvent(
        sessionToken,
        "CREATE_DIRECT_CALL",
        "DIRECT_CALL",
        directCallID,
        {
          mrd: mrdNo,
          patientName: data.patientName || "",
          patientType: data.patientType || "",
          callType: data.callType || "",
          caseType: data.caseType || "",
          urgency: data.urgency || "",
          sheetName: "directCall",
        },
      );
    } catch (auditError) {
      // Don't fail direct call creation if audit logging fails
      Logger.log(
        "Audit logging failed for direct call creation: " +
          auditError.toString(),
      );
    }

    return {
      success: true,
      message: "Direct call created successfully",
      directCallID: directCallID,
    };
  } catch (e) {
    return {
      success: false,
      message: "Error creating direct call: " + e.toString(),
    };
  }
}

/**
 * Search direct calls based on criteria
 * @param {Object} searchParams - Search parameters
 * @return {Object} Search results
 */
function searchDirectCalls(searchParams) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const directCallSheet = ss.getSheetByName("directCall");

    if (!directCallSheet) {
      return {
        success: true,
        directCalls: [],
        message: "No direct calls found",
      };
    }

    const data = directCallSheet.getDataRange().getValues();
    if (data.length <= 1) {
      return {
        success: true,
        directCalls: [],
        message: "No direct calls found",
      };
    }

    const headers = data[0];
    const directCallIDCol = headers.indexOf("DirectCallID");
    const mrdNoCol = headers.indexOf("MRDNo");
    const patientNameCol = headers.indexOf("PatientName");
    const ageCol = headers.indexOf("Age");
    const genderCol = headers.indexOf("Gender");
    const phoneCol = headers.indexOf("Phone");
    const patientTypeCol = headers.indexOf("PatientType");
    const callTypeCol = headers.indexOf("CallType");
    const caseTypeCol = headers.indexOf("CaseType");
    const urgencyCol = headers.indexOf("Urgency");
    const remarksCol = headers.indexOf("Remarks");
    const createdByCol = headers.indexOf("CreatedBy");
    const createdOnCol = headers.indexOf("CreatedOn");
    const statusCol = headers.indexOf("Status");

    const results = [];

    for (let i = 1; i < data.length; i++) {
      const row = data[i];

      // Skip if status is not Active (cancelled/archived entries)
      if (
        statusCol !== -1 &&
        row[statusCol] &&
        row[statusCol].toString().toLowerCase() !== "active"
      ) {
        continue;
      }

      // Apply filters
      let matches = true;

      if (searchParams.mrdNo) {
        let searchMRD = searchParams.mrdNo.trim().toUpperCase();
        if (/^\d+$/.test(searchMRD)) {
          searchMRD = "SPD" + searchMRD;
        }
        const rowMRD = row[mrdNoCol]
          ? row[mrdNoCol].toString().toUpperCase()
          : "";
        if (!rowMRD.includes(searchMRD)) {
          matches = false;
        }
      }

      if (matches && searchParams.patientName) {
        const name = row[patientNameCol]
          ? row[patientNameCol].toString().toLowerCase()
          : "";
        if (!name.includes(searchParams.patientName.toLowerCase())) {
          matches = false;
        }
      }

      if (matches && searchParams.phone) {
        const phone = row[phoneCol] ? row[phoneCol].toString() : "";
        if (!phone.includes(searchParams.phone)) {
          matches = false;
        }
      }

      if (matches && searchParams.date) {
        const createdOn = row[createdOnCol];
        if (createdOn) {
          let dateStr = "";
          if (createdOn instanceof Date) {
            dateStr = Utilities.formatDate(
              createdOn,
              Session.getScriptTimeZone(),
              "yyyy-MM-dd",
            );
          } else {
            dateStr = createdOn.toString().substring(0, 10);
          }
          if (dateStr !== searchParams.date) {
            matches = false;
          }
        } else {
          matches = false;
        }
      }

      if (matches) {
        let createdOnFormatted = "";
        if (row[createdOnCol]) {
          if (row[createdOnCol] instanceof Date) {
            createdOnFormatted = Utilities.formatDate(
              row[createdOnCol],
              Session.getScriptTimeZone(),
              "yyyy-MM-dd HH:mm:ss",
            );
          } else {
            createdOnFormatted = row[createdOnCol].toString();
          }
        }

        results.push({
          DirectCallID: row[directCallIDCol] || "",
          MRDNo: row[mrdNoCol] || "",
          PatientName: row[patientNameCol] || "",
          Age: row[ageCol] || "",
          Gender: row[genderCol] || "",
          Phone: row[phoneCol] || "",
          PatientType: row[patientTypeCol] || "",
          CallType: row[callTypeCol] || "",
          CaseType: row[caseTypeCol] || "",
          Urgency: row[urgencyCol] || "",
          Remarks: row[remarksCol] || "",
          CreatedBy: row[createdByCol] || "",
          CreatedOn: createdOnFormatted,
          Status: row[statusCol] || "Active",
        });
      }
    }

    // Sort by CreatedOn descending (newest first)
    results.sort((a, b) => {
      return new Date(b.CreatedOn) - new Date(a.CreatedOn);
    });

    return {
      success: true,
      directCalls: results,
    };
  } catch (e) {
    return {
      success: false,
      message: "Error searching direct calls: " + e.toString(),
    };
  }
}

/**
 * Update a direct call entry
 * @param {string} directCallID - The direct call ID to update
 * @param {Object} updateData - Data to update
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Success/failure response
 */
function updateDirectCall(directCallID, updateData, sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const directCallSheet = ss.getSheetByName("directCall");

    if (!directCallSheet) {
      return { success: false, message: "Direct call sheet not found" };
    }

    const data = directCallSheet.getDataRange().getValues();
    const headers = data[0];
    const directCallIDCol = headers.indexOf("DirectCallID");
    const remarksCol = headers.indexOf("Remarks");

    if (directCallIDCol === -1) {
      return { success: false, message: "DirectCallID column not found" };
    }

    // Find the row
    let rowIndex = -1;
    for (let i = 1; i < data.length; i++) {
      if (
        data[i][directCallIDCol] &&
        data[i][directCallIDCol].toString() === directCallID
      ) {
        rowIndex = i;
        break;
      }
    }

    if (rowIndex === -1) {
      return {
        success: false,
        message: "Direct call not found: " + directCallID,
      };
    }

    // Update remarks if provided
    if (updateData.remarks !== undefined && remarksCol !== -1) {
      directCallSheet
        .getRange(rowIndex + 1, remarksCol + 1)
        .setValue(updateData.remarks);
    }

    // Log audit event
    logAuditEvent(
      sessionToken,
      "UPDATE_DIRECT_CALL",
      "DIRECT_CALL",
      directCallID,
      {
        sheetName: "directCall",
        updatedFields: updateData,
        mrdNo: data[rowIndex][headers.indexOf("MRDNo")],
        patientName: data[rowIndex][headers.indexOf("PatientName")],
      },
    );

    return {
      success: true,
      message: "Direct call updated successfully",
    };
  } catch (e) {
    return {
      success: false,
      message: "Error updating direct call: " + e.toString(),
    };
  }
}

/**
 * Cancel a direct call - moves from directCall sheet to cancel sheet
 * @param {string} directCallID - The direct call ID to cancel
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Success/failure response
 */
function cancelDirectCall(directCallID, sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const directCallSheet = ss.getSheetByName("directCall");
    const cancelSheet = ss.getSheetByName("cancel");

    if (!directCallSheet) {
      return { success: false, message: "Direct call sheet not found" };
    }

    if (!cancelSheet) {
      return { success: false, message: "Cancel sheet not found" };
    }

    // Get direct call data
    const directCallData = directCallSheet.getDataRange().getValues();
    const headers = directCallData[0];

    // Find column indices
    const directCallIDCol = headers.indexOf("DirectCallID");
    const mrdNoCol = headers.indexOf("MRDNo");
    const patientNameCol = headers.indexOf("PatientName");
    const ageCol = headers.indexOf("Age");
    const genderCol = headers.indexOf("Gender");
    const phoneCol = headers.indexOf("Phone");
    const remarksCol = headers.indexOf("Remarks");

    if (directCallIDCol === -1) {
      return { success: false, message: "DirectCallID column not found" };
    }

    // Find the row
    let rowIndex = -1;
    let directCallRow = null;
    for (let i = 1; i < directCallData.length; i++) {
      if (
        directCallData[i][directCallIDCol] &&
        directCallData[i][directCallIDCol].toString() === directCallID
      ) {
        rowIndex = i;
        directCallRow = directCallData[i];
        break;
      }
    }

    if (rowIndex === -1 || !directCallRow) {
      return {
        success: false,
        message: "Direct call not found: " + directCallID,
      };
    }

    // Get username
    const username = getSessionUsername(sessionToken);
    const now = new Date();

    // Auto-generate AppointmentID for cancel sheet
    const appointmentID =
      "DC_" +
      Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyyMMdd_HHmmss");

    // Ensure journey column exists
    const cancelJourneyColIndex = ensureJourneyColumn(cancelSheet);

    // Create journey entry
    const journeyEntry = {
      timestamp: now.toISOString(),
      action: "cancelled",
      by: username,
      fromSheet: "directCall",
      toSheet: "cancel",
      description: "Direct call cancelled and moved to cancel sheet",
      directCallID: directCallID,
    };

    // Build cancel row with at least 36 columns
    const cancelRow = new Array(36).fill("");

    cancelRow[0] = appointmentID; // Column A - AppointmentID
    cancelRow[1] = now; // Column B - AppointmentDate
    cancelRow[2] = ""; // Column C - TimeSlot
    cancelRow[3] = directCallRow[mrdNoCol] || ""; // Column D - MRDNo
    cancelRow[4] = directCallRow[patientNameCol] || ""; // Column E - PatientName
    cancelRow[5] = directCallRow[ageCol] || ""; // Column F - Age
    cancelRow[6] = directCallRow[genderCol] || ""; // Column G - Gender
    cancelRow[7] = directCallRow[phoneCol] || ""; // Column H - Phone
    cancelRow[8] = "Direct Call"; // Column I - AppointmentType
    cancelRow[9] = ""; // Column J - Doctor
    cancelRow[10] = ""; // Column K - PlanOfAction
    cancelRow[11] = directCallRow[remarksCol] || ""; // Column L - Remarks
    cancelRow[21] = now; // Column V - DeletedOn
    cancelRow[22] = username; // Column W - DeletedBy
    cancelRow[30] = directCallID; // Column AE - DirectCallID
    if (cancelJourneyColIndex !== -1) {
      cancelRow[cancelJourneyColIndex] = JSON.stringify([journeyEntry]);
    }

    // Append to cancel sheet
    cancelSheet.appendRow(cancelRow);

    // Delete from direct call sheet
    directCallSheet.deleteRow(rowIndex + 1);

    // Log audit event
    logAuditEvent(
      sessionToken,
      "CANCEL_DIRECT_CALL",
      "DIRECT_CALL",
      directCallID,
      {
        sheetName: "directCall",
        movedToSheet: "cancel",
        newAppointmentID: appointmentID,
        mrdNo: directCallRow[mrdNoCol] || "",
        patientName: directCallRow[patientNameCol] || "",
        cancelledBy: username,
      },
    );

    return {
      success: true,
      message: "Direct call cancelled successfully",
      appointmentID: appointmentID,
    };
  } catch (e) {
    return {
      success: false,
      message: "Error cancelling direct call: " + e.toString(),
    };
  }
}

/**
 * Archive a direct call - moves from directCall sheet to Archive sheet
 * @param {string} directCallID - The direct call ID to archive
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Success/failure response
 */
function archiveDirectCall(directCallID, sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const directCallSheet = ss.getSheetByName("directCall");
    const archiveSheet = ss.getSheetByName("Archive");

    if (!directCallSheet) {
      return { success: false, message: "Direct call sheet not found" };
    }

    if (!archiveSheet) {
      return { success: false, message: "Archive sheet not found" };
    }

    // Get direct call data
    const directCallData = directCallSheet.getDataRange().getValues();
    const headers = directCallData[0];

    // Find column indices
    const directCallIDCol = headers.indexOf("DirectCallID");
    const mrdNoCol = headers.indexOf("MRDNo");
    const patientNameCol = headers.indexOf("PatientName");
    const ageCol = headers.indexOf("Age");
    const genderCol = headers.indexOf("Gender");
    const phoneCol = headers.indexOf("Phone");
    const remarksCol = headers.indexOf("Remarks");

    if (directCallIDCol === -1) {
      return { success: false, message: "DirectCallID column not found" };
    }

    // Find the row
    let rowIndex = -1;
    let directCallRow = null;
    for (let i = 1; i < directCallData.length; i++) {
      if (
        directCallData[i][directCallIDCol] &&
        directCallData[i][directCallIDCol].toString() === directCallID
      ) {
        rowIndex = i;
        directCallRow = directCallData[i];
        break;
      }
    }

    if (rowIndex === -1 || !directCallRow) {
      return {
        success: false,
        message: "Direct call not found: " + directCallID,
      };
    }

    // Get username
    const username = getSessionUsername(sessionToken);
    const now = new Date();

    // Auto-generate AppointmentID for archive sheet
    const appointmentID =
      "DC_" +
      Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyyMMdd_HHmmss");

    // Ensure journey column exists
    const archiveJourneyColIndex = ensureJourneyColumn(archiveSheet);

    // Create journey entry
    const journeyEntry = {
      timestamp: now.toISOString(),
      action: "archived",
      by: username,
      fromSheet: "directCall",
      toSheet: "Archive",
      description: "Direct call archived",
      directCallID: directCallID,
    };

    // Build archive row with at least 36 columns
    const archiveRow = new Array(36).fill("");

    archiveRow[0] = appointmentID; // Column A - AppointmentID
    archiveRow[1] = now; // Column B - AppointmentDate
    archiveRow[2] = ""; // Column C - TimeSlot
    archiveRow[3] = directCallRow[mrdNoCol] || ""; // Column D - MRDNo
    archiveRow[4] = directCallRow[patientNameCol] || ""; // Column E - PatientName
    archiveRow[5] = directCallRow[ageCol] || ""; // Column F - Age
    archiveRow[6] = directCallRow[genderCol] || ""; // Column G - Gender
    archiveRow[7] = directCallRow[phoneCol] || ""; // Column H - Phone
    archiveRow[8] = "Direct Call"; // Column I - AppointmentType
    archiveRow[9] = ""; // Column J - Doctor
    archiveRow[10] = ""; // Column K - PlanOfAction
    archiveRow[11] = directCallRow[remarksCol] || ""; // Column L - Remarks
    archiveRow[21] = now; // Column V - ArchivedOn
    archiveRow[22] = username; // Column W - ArchivedBy
    archiveRow[30] = directCallID; // Column AE - DirectCallID
    if (archiveJourneyColIndex !== -1) {
      archiveRow[archiveJourneyColIndex] = JSON.stringify([journeyEntry]);
    }

    // Append to archive sheet
    archiveSheet.appendRow(archiveRow);

    // Delete from direct call sheet
    directCallSheet.deleteRow(rowIndex + 1);

    // Log audit event
    logAuditEvent(
      sessionToken,
      "ARCHIVE_DIRECT_CALL",
      "DIRECT_CALL",
      directCallID,
      {
        sheetName: "directCall",
        movedToSheet: "Archive",
        newAppointmentID: appointmentID,
        mrdNo: directCallRow[mrdNoCol] || "",
        patientName: directCallRow[patientNameCol] || "",
        archivedBy: username,
      },
    );

    return {
      success: true,
      message: "Direct call archived successfully",
      appointmentID: appointmentID,
    };
  } catch (e) {
    return {
      success: false,
      message: "Error archiving direct call: " + e.toString(),
    };
  }
}

/**
 * Create an appointment from a direct call
 * @param {Object} appointmentData - Appointment details
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Success/failure response
 */
function createAppointmentFromDirectCall(appointmentData, sessionToken) {
  try {
    // Validate appointment data format
    const validation = validateAppointmentData(appointmentData);
    if (!validation.valid) {
      return {
        success: false,
        message: "Validation failed: " + validation.errors.join(", "),
      };
    }

    // Normalize date and time values
    try {
      appointmentData.appointmentDate = normalizeAppointmentDate(
        appointmentData.appointmentDate,
      );
      if (
        appointmentData.timeSlot &&
        appointmentData.appointmentType !== "WAITING LIST"
      ) {
        appointmentData.timeSlot = normalizeTimeSlot(appointmentData.timeSlot);
      }
    } catch (normalizationError) {
      return {
        success: false,
        message: "Data normalization failed: " + normalizationError.message,
      };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentSheet = ss.getSheetByName("appointment");
    const directCallSheet = ss.getSheetByName("directCall");

    if (!appointmentSheet) {
      throw new Error("Appointment sheet not found.");
    }

    if (!directCallSheet) {
      throw new Error("Direct call sheet not found.");
    }

    // Check slot availability for the appointment date (skip for WAITING LIST)
    if (
      appointmentData.appointmentType !== "WAITING LIST" &&
      appointmentData.timeSlot
    ) {
      const slotAvailability = checkSlotAvailability(
        appointmentData.appointmentDate,
      );
      if (!slotAvailability.available) {
        return {
          success: false,
          message:
            slotAvailability.message ||
            "No slots available for the selected date. MaxSlots may not be set or all slots are booked.",
        };
      }
    }

    // Get direct call data
    const directCallData = directCallSheet.getDataRange().getValues();
    const headers = directCallData[0];
    const directCallIDCol = headers.indexOf("DirectCallID");
    const mrdNoCol = headers.indexOf("MRDNo");
    const patientNameCol = headers.indexOf("PatientName");
    const ageCol = headers.indexOf("Age");
    const genderCol = headers.indexOf("Gender");
    const phoneCol = headers.indexOf("Phone");
    const remarksCol = headers.indexOf("Remarks");
    const statusCol = headers.indexOf("Status");

    if (directCallIDCol === -1) {
      throw new Error("DirectCallID column not found in direct call sheet");
    }

    // Find the direct call record
    let directCallRow = null;
    let directCallRowIndex = -1;
    for (let i = 1; i < directCallData.length; i++) {
      if (
        directCallData[i][directCallIDCol] &&
        directCallData[i][directCallIDCol].toString() ===
          appointmentData.directCallID
      ) {
        directCallRow = directCallData[i];
        directCallRowIndex = i;
        break;
      }
    }

    if (!directCallRow) {
      throw new Error(
        "Direct call record not found for ID: " + appointmentData.directCallID,
      );
    }

    // Get patient data from direct call
    const patientData = {
      MRDNo: directCallRow[mrdNoCol] || "",
      Name: directCallRow[patientNameCol] || "",
      Age: directCallRow[ageCol] || "",
      Gender: directCallRow[genderCol] || "",
      Phone: directCallRow[phoneCol] || "",
      Address: "",
      Type: "",
    };

    // Get username
    const username = getSessionUsername(sessionToken);
    const now = new Date();

    // Generate timestamp-based appointment ID
    const appointmentID = Utilities.formatDate(
      now,
      Session.getScriptTimeZone(),
      "yyyyMMdd_HHmmss",
    );

    // Parse plan of action
    let planOfAction = appointmentData.planOfAction || "";
    if (planOfAction) {
      try {
        const planArray = JSON.parse(planOfAction);
        if (Array.isArray(planArray)) {
          planOfAction = planArray.join(", ");
        }
      } catch (e) {
        // Keep as is if not JSON
      }
    }

    // Combine remarks
    let remarks = directCallRow[remarksCol] || "";
    if (appointmentData.additionalComments) {
      remarks = remarks
        ? remarks + " | " + appointmentData.additionalComments
        : appointmentData.additionalComments;
    }

    // Create journey entry
    const journeyEntry = {
      timestamp: now.toISOString(),
      action: "booked",
      by: username,
      fromSheet: "directCall",
      toSheet: "appointment",
      description: "Appointment booked from direct call",
      directCallID: appointmentData.directCallID,
    };

    // Ensure journey column exists
    const journeyColIndex = ensureJourneyColumn(appointmentSheet);

    // Build appointment row (matching the appointment sheet structure)
    const appointmentRow = new Array(Math.max(36, journeyColIndex + 1)).fill(
      "",
    );

    appointmentRow[0] = appointmentID; // Column A - AppointmentID
    appointmentRow[1] = appointmentData.appointmentDate; // Column B - AppointmentDate (normalized YYYY-MM-DD)
    appointmentRow[2] = appointmentData.timeSlot || ""; // Column C - TimeSlot (normalized HH:MM)
    appointmentRow[3] = patientData.MRDNo || ""; // Column D - MRDNo
    appointmentRow[4] = patientData.Name || ""; // Column E - PatientName
    appointmentRow[5] = patientData.Age || ""; // Column F - Age
    appointmentRow[6] = patientData.Gender || ""; // Column G - Gender
    appointmentRow[7] = patientData.Phone || ""; // Column H - Phone
    appointmentRow[8] = appointmentData.appointmentType || ""; // Column I - AppointmentType
    appointmentRow[9] = appointmentData.doctor || ""; // Column J - Doctor
    appointmentRow[10] = planOfAction; // Column K - PlanOfAction
    appointmentRow[11] = remarks; // Column L - Remarks
    appointmentRow[12] = username; // Column M - BookedBy
    appointmentRow[13] = now; // Column N - BookingDate
    appointmentRow[30] = appointmentData.directCallID; // Column AE - DirectCallID
    if (journeyColIndex !== -1) {
      appointmentRow[journeyColIndex] = JSON.stringify([journeyEntry]);
    }

    // Append to appointment sheet
    appointmentSheet.appendRow(appointmentRow);

    // Update direct call status to "Booked"
    if (statusCol !== -1) {
      directCallSheet
        .getRange(directCallRowIndex + 1, statusCol + 1)
        .setValue("Booked");
    }

    // Delete from direct call sheet (optional - or just mark as booked)
    directCallSheet.deleteRow(directCallRowIndex + 1);

    // Update planningA sheet to mark slot as booked
    try {
      updatePlanningASheet();
    } catch (planningError) {}

    // Update planningB stats after booking
    try {
      updatePlanningBStats(appointmentData.appointmentDate);
    } catch (planningBError) {}

    // Log audit event for appointment booking from direct call
    try {
      logAuditEvent(
        sessionToken,
        "BOOK_APPOINTMENT_FROM_DIRECT_CALL",
        "APPOINTMENT",
        appointmentID,
        {
          date: appointmentData.appointmentDate,
          time: appointmentData.timeSlot || "WAITING LIST",
          mrd: patientData.MRDNo,
          patientName: patientData.Name,
          doctor: appointmentData.doctor,
          appointmentType: appointmentData.appointmentType,
          directCallID: appointmentData.directCallID,
          sheetName: "appointment",
        },
      );
    } catch (auditError) {
      // Don't fail appointment creation if audit logging fails
      Logger.log(
        "Audit logging failed for direct call appointment booking: " +
          auditError.toString(),
      );
    }

    return {
      success: true,
      message: "Appointment booked successfully",
      appointmentID: appointmentID,
    };
  } catch (e) {
    return {
      success: false,
      message: "Error booking appointment: " + e.toString(),
    };
  }
}

/**
 * Get details of a specific direct call
 * @param {string} directCallID - The direct call ID
 * @return {Object} Direct call details
 */
function getDirectCallDetails(directCallID) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const directCallSheet = ss.getSheetByName("directCall");

    if (!directCallSheet) {
      return { success: false, message: "Direct call sheet not found" };
    }

    const data = directCallSheet.getDataRange().getValues();
    const headers = data[0];

    const directCallIDCol = headers.indexOf("DirectCallID");

    if (directCallIDCol === -1) {
      return { success: false, message: "DirectCallID column not found" };
    }

    for (let i = 1; i < data.length; i++) {
      if (
        data[i][directCallIDCol] &&
        data[i][directCallIDCol].toString() === directCallID
      ) {
        const row = data[i];
        const result = {};

        for (let j = 0; j < headers.length; j++) {
          let value = row[j];
          if (value instanceof Date) {
            value = Utilities.formatDate(
              value,
              Session.getScriptTimeZone(),
              "yyyy-MM-dd HH:mm:ss",
            );
          }
          result[headers[j]] = value || "";
        }

        return {
          success: true,
          directCall: result,
        };
      }
    }

    return {
      success: false,
      message: "Direct call not found: " + directCallID,
    };
  } catch (e) {
    return {
      success: false,
      message: "Error getting direct call details: " + e.toString(),
    };
  }
}

/**
 * Submit a triage assessment for urgency identification
 * @param {Object} data - Assessment data including patient info and question scores
 * @param {string} sessionToken - Session token for authentication
 * @return {Object} Result with success status, total score, and category
 */
function submitTriageAssessment(data, sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let triageSheet = ss.getSheetByName("urgencyIdentification");

    // Create sheet if it doesn't exist
    if (!triageSheet) {
      triageSheet = ss.insertSheet("urgencyIdentification");
      // Add headers
      const headers = [
        "TriageID",
        "AssessmentDate",
        "PatientName",
        "Age",
        "Gender",
        "Phone",
        "PatientType",
        "MRDNo",
        "Q1_Onset",
        "Q2_Vision",
        "Q3_Pain",
        "Q4_Floaters",
        "Q5_Redness",
        "Q6_Injury",
        "Q7_Symptoms",
        "MaxScore",
        "Category",
        "CreatedBy",
        "CreatedOn",
      ];
      triageSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      triageSheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");

      // Format header row
      triageSheet.setFrozenRows(1);
    }

    // Get username from session
    const username = getSessionUsername(sessionToken) || "Unknown";
    const now = new Date();

    // Generate TriageID (format: TRG_yyyyMMdd_HHmmss_xxx)
    const timestamp = Utilities.formatDate(
      now,
      Session.getScriptTimeZone(),
      "yyyyMMdd_HHmmss",
    );
    const random = Math.floor(Math.random() * 1000)
      .toString()
      .padStart(3, "0");
    const triageID = "TRG_" + timestamp + "_" + random;

    // Format date for display
    const createdOn = Utilities.formatDate(
      now,
      Session.getScriptTimeZone(),
      "yyyy-MM-dd HH:mm:ss",
    );

    // Get individual question scores
    const q1 = parseInt(data.q1) || 0;
    const q2 = parseInt(data.q2) || 0;
    const q3 = parseInt(data.q3) || 0;
    const q4 = parseInt(data.q4) || 0;
    const q5 = parseInt(data.q5) || 0;
    const q6 = parseInt(data.q6) || 0;
    const q7 = parseInt(data.q7) || 0;

    // Find the maximum score from all questions
    const scores = [q1, q2, q3, q4, q5, q6, q7];
    const maxScore = Math.max(...scores);

    // Determine category based on HIGHEST score (not sum)
    // If any score is 3 → Emergency
    // If no 3s but at least one 2 → Urgent
    // If all scores are 1 → Not Urgent
    let category = "";
    if (maxScore === 3) {
      category = "Emergency";
    } else if (maxScore === 2) {
      category = "Urgent";
    } else {
      category = "Not Urgent";
    }

    // Normalize MRD number if provided
    let mrdNo = data.mrdNo || "";
    if (mrdNo && /^\d+$/.test(mrdNo)) {
      mrdNo = "SPD" + mrdNo;
    } else if (mrdNo && /^SPD/i.test(mrdNo)) {
      mrdNo = "SPD" + mrdNo.replace(/^SPD/i, "");
    }

    // Build row
    const newRow = [
      triageID,
      data.assessmentDate || "",
      data.patientName || "",
      data.age || "",
      data.gender || "",
      data.phone || "",
      data.patientType || "",
      mrdNo,
      q1,
      q2,
      q3,
      q4,
      q5,
      q6,
      q7,
      maxScore,
      category,
      username,
      createdOn,
    ];

    // Append row
    triageSheet.appendRow(newRow);

    // Apply conditional formatting for category column (column 17 = Q)
    // Emergency = Red, Urgent = Orange, Not Urgent = Green
    const lastRow = triageSheet.getLastRow();
    const categoryCell = triageSheet.getRange(lastRow, 17);

    if (category === "Emergency") {
      categoryCell
        .setBackground("#fee2e2")
        .setFontColor("#dc2626")
        .setFontWeight("bold");
    } else if (category === "Urgent") {
      categoryCell
        .setBackground("#fef3c7")
        .setFontColor("#d97706")
        .setFontWeight("bold");
    } else {
      categoryCell
        .setBackground("#d1fae5")
        .setFontColor("#059669")
        .setFontWeight("bold");
    }

    logAuditEvent(sessionToken, "CREATE_TRIAGE_ASSESSMENT", "TRIAGE", triageID, { patientName: data.patientName || "", mrdNo: mrdNo, category: category, maxScore: maxScore, assessmentDate: data.assessmentDate || "", sheetName: "urgencyIdentification" });

    return {
      success: true,
      message: "Assessment submitted successfully",
      triageID: triageID,
      maxScore: maxScore,
      category: category,
    };
  } catch (e) {
    return {
      success: false,
      message: "Error submitting assessment: " + e.toString(),
    };
  }
}

// ===========================
// DUPLICATE MRD WARNING SYSTEM
// ===========================

/**
 * Checks if an MRD number already exists in the appointment sheet
 * Used to warn users when booking appointments for patients who already have existing appointments
 * @param {string} mrdNo - The MRD number to check
 * @return {Object} Result object with duplicates array and metadata
 *   - success: boolean - Whether the check completed successfully
 *   - hasDuplicates: boolean - True if matching MRD numbers were found
 *   - duplicates: Array - List of matching appointment records
 *   - message: string - Human-readable status message
 */
function checkDuplicateMRDInAppointments(mrdNo) {
  try {
    // Handle empty/null/whitespace MRD inputs - return hasDuplicates: false without searching
    if (!mrdNo || (typeof mrdNo === "string" && mrdNo.trim() === "")) {
      return {
        success: true,
        hasDuplicates: false,
        duplicates: [],
        message: "No MRD number provided, skipping duplicate check",
      };
    }

    // Normalize the MRD number for comparison
    var normalizedMrd = mrdNo.toString().trim();

    // Apply same normalization logic as other MRD functions
    if (/^\d+$/.test(normalizedMrd)) {
      normalizedMrd = "SPD" + normalizedMrd;
    } else if (/^SPD$/i.test(normalizedMrd)) {
      normalizedMrd = "SPD0";
    } else if (/^SPD/i.test(normalizedMrd)) {
      var numPart = normalizedMrd.replace(/^SPD/i, "");
      if (/^\d+$/.test(numPart)) {
        normalizedMrd = "SPD" + numPart;
      }
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var appointmentSheet = ss.getSheetByName("appointment");

    if (!appointmentSheet) {
      return {
        success: false,
        hasDuplicates: false,
        duplicates: [],
        message: "Appointment sheet not found",
      };
    }

    var data = appointmentSheet.getDataRange().getValues();

    if (data.length <= 1) {
      // Only header row or empty sheet
      return {
        success: true,
        hasDuplicates: false,
        duplicates: [],
        message: "No appointments found in the system",
      };
    }

    var headers = data[0];

    // Find column indices - using header names for flexibility
    var appointmentIDCol = 0; // Column A - AppointmentID
    var appointmentDateCol = 1; // Column B - AppointmentDate
    var timeSlotCol = 2; // Column C - TimeSlot
    var mrdCol = 3; // Column D - MRDNo
    var patientNameCol = 4; // Column E - Name

    // Verify MRD column exists by checking header
    var mrdColIndex = -1;
    for (var i = 0; i < headers.length; i++) {
      if (headers[i] && typeof headers[i] === "string") {
        var headerLower = headers[i].toLowerCase().replace(/\s+/g, "");
        if (headerLower === "mrdno" || headerLower === "mrd") {
          mrdColIndex = i;
          break;
        }
      }
    }

    if (mrdColIndex === -1) {
      // Fall back to column D (index 3) if header not found
      mrdColIndex = mrdCol;
    }

    var duplicates = [];

    // Search for all appointments with matching MRD number
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var rowMrd = row[mrdColIndex] ? row[mrdColIndex].toString().trim() : "";

      // Normalize row MRD for comparison
      var normalizedRowMrd = rowMrd;
      if (/^\d+$/.test(normalizedRowMrd)) {
        normalizedRowMrd = "SPD" + normalizedRowMrd;
      } else if (/^SPD/i.test(normalizedRowMrd)) {
        normalizedRowMrd = "SPD" + normalizedRowMrd.replace(/^SPD/i, "");
      }

      // Case-insensitive comparison
      if (normalizedRowMrd.toUpperCase() === normalizedMrd.toUpperCase()) {
        // Format appointment date
        var appointmentDate = row[appointmentDateCol];
        var formattedDate = "";
        if (appointmentDate) {
          if (appointmentDate instanceof Date) {
            formattedDate = Utilities.formatDate(
              appointmentDate,
              Session.getScriptTimeZone(),
              "yyyy-MM-dd",
            );
          } else {
            formattedDate = appointmentDate.toString();
          }
        }

        duplicates.push({
          appointmentID: row[appointmentIDCol]
            ? row[appointmentIDCol].toString()
            : "",
          appointmentDate: formattedDate,
          patientName: row[patientNameCol]
            ? row[patientNameCol].toString()
            : "",
          timeSlot: row[timeSlotCol] ? row[timeSlotCol].toString() : "",
        });
      }
    }

    var hasDuplicates = duplicates.length > 0;
    var message = hasDuplicates
      ? "Found " +
        duplicates.length +
        " existing appointment(s) for MRD: " +
        normalizedMrd
      : "No existing appointments found for MRD: " + normalizedMrd;

    return {
      success: true,
      hasDuplicates: hasDuplicates,
      duplicates: duplicates,
      message: message,
    };
  } catch (error) {
    return {
      success: false,
      hasDuplicates: false,
      duplicates: [],
      message: "Error checking for duplicates: " + error.toString(),
    };
  }
}

// ===========================
// MONTHLY REPORT GENERATION
// ===========================

/**
 * Generate monthly report data for PDF/Excel export
 * @param {number} year - Year
 * @param {number} month - Month (0-11)
 * @param {string} doctor - Doctor name (optional)
 * @param {string} sessionToken - Session token
 * @return {Object} Report data with all required columns
 */
function generateMonthlyReportData(year, month, doctor, sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentSheet = ss.getSheetByName("appointment");
    const directCallSheet = ss.getSheetByName("directCall");
    const cancelSheet = ss.getSheetByName("cancel");
    const planningBSheet = ss.getSheetByName("planningB");

    if (!appointmentSheet) {
      return { success: false, message: "Appointment sheet not found" };
    }

    // Get appointments for the month
    const appointmentsData = getAppointmentsForMonth(year, month, doctor);

    // Get planningB data for the month
    const planningBData = getPlanningBDataForMonth(year, month);
    const planningData = planningBData.success ? planningBData.data : {};

    // Get doctor availability data
    const doctorAvailabilityData = getDoctorAvailabilityDataToday(doctor);

    // Get exception map for the month
    const monthKey = year + "-" + String(month + 1).padStart(2, "0");
    const exceptionMap = getDoctorMonthlyExceptionMap(monthKey, doctor);

    // Get total unique MRD counts from directCall and cancel sheets (all records, no date filter)
    const directCallMRDs = getTotalUniqueMRDs(directCallSheet);
    const cancelMRDs = getTotalUniqueMRDs(cancelSheet);

    // Calculate days in month
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const dayNames = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];

    // Build report data for each day
    const reportData = [];

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr =
        year +
        "-" +
        String(month + 1).padStart(2, "0") +
        "-" +
        String(day).padStart(2, "0");
      const currentDate = new Date(year, month, day);
      const dayOfWeek = currentDate.getDay();
      const dayName = dayNames[dayOfWeek];

      // Get appointment counts for this day
      const dayAppointments = appointmentsData[day] || {};
      const newCount = dayAppointments.NEW || 0;
      const oldCount = dayAppointments.OLD || 0;
      const wlCount = dayAppointments["WAITING LIST"] || 0;

      // Get planningB data for this day
      const dayPlanning = planningData[day] || {};
      const maxSlots = dayPlanning.maxSlots || 0;
      const naa = dayPlanning.naa || 0;
      const oaa = dayPlanning.oaa || 0;
      const taa = dayPlanning.taa || 0;
      const raa = dayPlanning.raa || 0;

      // Calculate metrics
      const totalAppointments = newCount + oldCount;
      const tfa = totalAppointments - wlCount; // Total Fixed Appointments
      const capacityPercent =
        maxSlots > 0 ? Math.round((taa / maxSlots) * 100) : 0;
      const utilizationPercent =
        maxSlots > 0 ? Math.round((totalAppointments / maxSlots) * 100) : 0;
      const remainingSlots = Math.max(0, maxSlots - totalAppointments);

      // Calculate load percentage (consult time utilization)
      const loadData = calculateDayLoad(dateStr);
      const loadPercent =
        loadData.totalAvailableMinutes > 0
          ? Math.round(
              (loadData.totalConsultTime / loadData.totalAvailableMinutes) *
                100,
            )
          : 0;

      reportData.push({
        sNo: day,
        date: day,
        week: dayName,
        maxSlot: maxSlots,
        taa: taa,
        naa: naa,
        oaa: oaa,
        raa: raa,
        old: oldCount,
        new: newCount,
        wl: wlCount,
        tfa: tfa,
        capacityPercent: capacityPercent,
        utilizationPercent: utilizationPercent,
        remainingSlots: remainingSlots,
        totalAppointments: totalAppointments,
        loadPercent: loadPercent,
      });
    }

    // Calculate totals and averages
    const totals = {
      maxSlot: reportData.reduce((sum, row) => sum + row.maxSlot, 0),
      taa: reportData.reduce((sum, row) => sum + row.taa, 0),
      naa: reportData.reduce((sum, row) => sum + row.naa, 0),
      oaa: reportData.reduce((sum, row) => sum + row.oaa, 0),
      raa: reportData.reduce((sum, row) => sum + row.raa, 0),
      old: reportData.reduce((sum, row) => sum + row.old, 0),
      new: reportData.reduce((sum, row) => sum + row.new, 0),
      wl: reportData.reduce((sum, row) => sum + row.wl, 0),
      tfa: reportData.reduce((sum, row) => sum + row.tfa, 0),
      totalAppointments: reportData.reduce(
        (sum, row) => sum + row.totalAppointments,
        0,
      ),
      remainingSlots: reportData.reduce(
        (sum, row) => sum + row.remainingSlots,
        0,
      ),
    };

    const avgCapacity =
      totals.maxSlot > 0 ? Math.round((totals.taa / totals.maxSlot) * 100) : 0;
    const avgUtilization =
      totals.maxSlot > 0
        ? Math.round((totals.totalAppointments / totals.maxSlot) * 100)
        : 0;
    const avgLoad = Math.round(
      reportData.reduce((sum, row) => sum + row.loadPercent, 0) / daysInMonth,
    );

    const monthNames = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];

    return {
      success: true,
      reportData: reportData,
      totals: totals,
      averages: {
        capacityPercent: avgCapacity,
        utilizationPercent: avgUtilization,
        loadPercent: avgLoad,
      },
      metadata: {
        year: year,
        month: month,
        monthName: monthNames[month],
        doctor: doctor || "All Doctors",
        generatedOn: new Date(),
        directCallCount: directCallMRDs,
        cancelCount: cancelMRDs,
      },
    };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

/**
 * Get total unique MRD count from a sheet (all records, no date filter)
 * This counts patients who are waiting for appointments (cancel/directCall sheets)
 * @param {Sheet} sheet - The sheet to search
 * @return {number} Count of unique MRDs
 */
function getTotalUniqueMRDs(sheet) {
  try {
    if (!sheet) return 0;

    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return 0;

    const headers = data[0];

    // For cancel sheet, MRDNo is in column D (index 3)
    // For directCall sheet, find MRDNo column by header
    let mrdCol = -1;

    // First try to find by header name
    for (let i = 0; i < headers.length; i++) {
      const header = headers[i];
      if (header && typeof header === "string") {
        const headerLower = header.toLowerCase().replace(/\s+/g, "");
        if (headerLower === "mrdno" || headerLower === "mrd") {
          mrdCol = i;
          break;
        }
      }
    }

    // If not found by header, use column D (index 3) as fallback for cancel sheet
    if (mrdCol === -1) {
      mrdCol = 3; // Column D
    }

    const uniqueMRDs = new Set();

    // Count all unique MRDs in the sheet (no date filtering)
    for (let i = 1; i < data.length; i++) {
      const row = data[i];

      // Get MRD from the identified column
      const mrd = row[mrdCol];
      if (mrd && mrd.toString().trim() !== "") {
        uniqueMRDs.add(mrd.toString().trim().toUpperCase());
      }
    }

    return uniqueMRDs.size;
  } catch (e) {
    return 0;
  }
}

/**
 * Generate monthly report in Excel format
 * @param {number} year - Year
 * @param {number} month - Month (0-11)
 * @param {string} doctor - Doctor name (optional)
 * @param {string} sessionToken - Session token
 * @return {string} URL of the generated Excel file
 */
function generateMonthlyExcel(year, month, doctor, sessionToken) {
  try {
    // Get report data
    const reportResult = generateMonthlyReportData(
      year,
      month,
      doctor,
      sessionToken,
    );
    if (!reportResult.success) {
      throw new Error(reportResult.message);
    }

    const { reportData, totals, averages, metadata } = reportResult;

    // Create new spreadsheet
    const fileName =
      "Monthly_Report_" +
      metadata.monthName +
      "_" +
      year +
      "_" +
      (doctor || "All");
    const ss = SpreadsheetApp.create(fileName);
    const sheet = ss.getActiveSheet();
    sheet.setName("Monthly Report");

    // Set up headers
    const headers = [
      "S.No",
      "Date",
      "Week",
      "MaxSlot",
      "TAA",
      "NAA",
      "OAA",
      "RAA",
      "OLD",
      "NEW",
      "WL",
      "TFA",
      "Capacity %",
      "Utilization %",
      "Remaining Slots",
      "Total Appointments",
      "Load %",
    ];

    // Write title
    sheet.getRange(1, 1, 1, headers.length).merge();
    sheet
      .getRange(1, 1)
      .setValue(
        "Monthly Report - " +
          metadata.monthName +
          " " +
          year +
          " - " +
          metadata.doctor,
      );
    sheet
      .getRange(1, 1)
      .setFontSize(14)
      .setFontWeight("bold")
      .setHorizontalAlignment("center");

    // Write metadata
    sheet
      .getRange(2, 1)
      .setValue(
        "Generated On: " +
          Utilities.formatDate(
            metadata.generatedOn,
            Session.getScriptTimeZone(),
            "yyyy-MM-dd HH:mm:ss",
          ),
      );
    sheet
      .getRange(3, 1)
      .setValue("Direct Call Patients: " + metadata.directCallCount);
    sheet
      .getRange(4, 1)
      .setValue("Cancelled Patients: " + metadata.cancelCount);

    // Write headers
    sheet.getRange(5, 1, 1, headers.length).setValues([headers]);
    sheet
      .getRange(5, 1, 1, headers.length)
      .setBackground("#4a90e2")
      .setFontColor("#ffffff")
      .setFontWeight("bold")
      .setHorizontalAlignment("center");

    // Write data
    const dataRows = reportData.map((row) => [
      row.sNo,
      row.date,
      row.week,
      row.maxSlot,
      row.taa,
      row.naa,
      row.oaa,
      row.raa,
      row.old,
      row.new,
      row.wl,
      row.tfa,
      row.capacityPercent + "%",
      row.utilizationPercent + "%",
      row.remainingSlots,
      row.totalAppointments,
      row.loadPercent + "%",
    ]);

    sheet.getRange(6, 1, dataRows.length, headers.length).setValues(dataRows);

    // Write totals
    const totalRow = 6 + dataRows.length;
    sheet.getRange(totalRow, 1).setValue("TOTAL");
    sheet.getRange(totalRow, 4).setValue(totals.maxSlot);
    sheet.getRange(totalRow, 5).setValue(totals.taa);
    sheet.getRange(totalRow, 6).setValue(totals.naa);
    sheet.getRange(totalRow, 7).setValue(totals.oaa);
    sheet.getRange(totalRow, 8).setValue(totals.raa);
    sheet.getRange(totalRow, 9).setValue(totals.old);
    sheet.getRange(totalRow, 10).setValue(totals.new);
    sheet.getRange(totalRow, 11).setValue(totals.wl);
    sheet.getRange(totalRow, 12).setValue(totals.tfa);
    sheet.getRange(totalRow, 13).setValue(averages.capacityPercent + "%");
    sheet.getRange(totalRow, 14).setValue(averages.utilizationPercent + "%");
    sheet.getRange(totalRow, 15).setValue(totals.remainingSlots);
    sheet.getRange(totalRow, 16).setValue(totals.totalAppointments);
    sheet.getRange(totalRow, 17).setValue(averages.loadPercent + "%");

    sheet
      .getRange(totalRow, 1, 1, headers.length)
      .setBackground("#e8f0fe")
      .setFontWeight("bold");

    // Auto-resize columns
    for (let i = 1; i <= headers.length; i++) {
      sheet.autoResizeColumn(i);
    }

    // Set borders
    sheet
      .getRange(5, 1, dataRows.length + 2, headers.length)
      .setBorder(
        true,
        true,
        true,
        true,
        true,
        true,
        "#000000",
        SpreadsheetApp.BorderStyle.SOLID,
      );

    SpreadsheetApp.flush();

    logAuditEvent(sessionToken, "EXPORT_MONTHLY_EXCEL", "REPORT", fileName, { year: year, month: month, doctor: doctor || "All", sheetName: "monthlyReport" });

    return ss.getUrl();
  } catch (e) {
    throw e;
  }
}

/**
 * Generate monthly report in PDF format (landscape)
 * @param {number} year - Year
 * @param {number} month - Month (0-11)
 * @param {string} doctor - Doctor name (optional)
 * @param {string} sessionToken - Session token
 * @return {string} URL of the generated PDF file (spreadsheet with PDF export link)
 */
function generateMonthlyPDF(year, month, doctor, sessionToken) {
  try {
    // Generate Excel spreadsheet
    const excelUrl = generateMonthlyExcel(year, month, doctor, sessionToken);

    // Extract spreadsheet ID from URL
    const ssId = excelUrl.match(/\/d\/([a-zA-Z0-9-_]+)/)[1];

    // Return PDF export URL (user can download directly)
    // This approach doesn't require Drive API permissions
    const pdfExportUrl =
      "https://docs.google.com/spreadsheets/d/" +
      ssId +
      "/export?format=pdf&portrait=false&size=A4&fitw=true&gridlines=true&top_margin=0.5&bottom_margin=0.5&left_margin=0.5&right_margin=0.5";

    logAuditEvent(sessionToken, "EXPORT_MONTHLY_PDF", "REPORT", "monthly_pdf_" + year + "_" + (month + 1), { year: year, month: month, doctor: doctor || "All", sheetName: "monthlyReport" });

    // Return the spreadsheet URL with a note that it can be exported as PDF
    return {
      spreadsheetUrl: excelUrl,
      pdfExportUrl: pdfExportUrl,
      spreadsheetId: ssId,
    };
  } catch (e) {
    throw e;
  }
}

// ===========================
// AUTOMATED MONTHLY REPORT SHEET
// ===========================

/**
 * Initialize or ensure the monthlyReport sheet exists with proper structure
 * @return {Sheet} The monthlyReport sheet
 */
function initializeMonthlyReportSheet() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let reportSheet = ss.getSheetByName("monthlyReport");

    if (!reportSheet) {
      reportSheet = ss.insertSheet("monthlyReport");

      // Set up headers
      const headers = [
        "S.No",
        "Date",
        "Week",
        "MaxSlot",
        "TAA",
        "NAA",
        "OAA",
        "RAA",
        "OLD",
        "NEW",
        "WL",
        "TFA",
        "Capacity %",
        "Utilization %",
        "Remaining Slots",
        "Total Appointments",
        "Load %",
        "Last Updated",
      ];

      reportSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      reportSheet.setFrozenRows(1);

      // Format header row
      reportSheet
        .getRange(1, 1, 1, headers.length)
        .setBackground("#4a90e2")
        .setFontColor("#ffffff")
        .setFontWeight("bold")
        .setHorizontalAlignment("center");

      // Auto-resize columns
      for (let i = 1; i <= headers.length; i++) {
        reportSheet.autoResizeColumn(i);
      }
    }

    return reportSheet;
  } catch (e) {
    throw e;
  }
}

/**
 * Update the monthlyReport sheet with current month and next 2 months data
 * This function is called automatically by the daily trigger
 * @return {Object} Success/failure response
 */
function updateMonthlyReportSheet() {
  try {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();

    // Get the report sheet
    const reportSheet = initializeMonthlyReportSheet();

    // Clear existing data (keep headers)
    const lastRow = reportSheet.getLastRow();
    if (lastRow > 1) {
      reportSheet
        .getRange(2, 1, lastRow - 1, reportSheet.getLastColumn())
        .clear();
    }

    let currentRow = 2;
    let allDataRows = [];
    let grandTotals = {
      maxSlot: 0,
      taa: 0,
      naa: 0,
      oaa: 0,
      raa: 0,
      old: 0,
      new: 0,
      wl: 0,
      tfa: 0,
      totalAppointments: 0,
      remainingSlots: 0,
    };
    let totalDays = 0;
    let totalLoadPercent = 0;

    // Process 3 months: current month + next 2 months
    for (let monthOffset = 0; monthOffset < 3; monthOffset++) {
      const targetDate = new Date(currentYear, currentMonth + monthOffset, 1);
      const year = targetDate.getFullYear();
      const month = targetDate.getMonth();

      // Generate report data for this month (all doctors)
      const reportResult = generateMonthlyReportData(year, month, null, null);

      if (!reportResult.success) {
        continue;
      }

      const { reportData, totals, averages, metadata } = reportResult;

      // Add month title row
      reportSheet.insertRowBefore(currentRow);
      reportSheet.getRange(currentRow, 1, 1, 18).merge();
      reportSheet
        .getRange(currentRow, 1)
        .setValue(
          "📅 " +
            metadata.monthName +
            " " +
            year +
            " | Direct Calls: " +
            metadata.directCallCount +
            " | Cancelled: " +
            metadata.cancelCount +
            " | Updated: " +
            Utilities.formatDate(
              now,
              Session.getScriptTimeZone(),
              "yyyy-MM-dd HH:mm:ss",
            ),
        );
      reportSheet
        .getRange(currentRow, 1)
        .setFontSize(11)
        .setFontWeight("bold")
        .setHorizontalAlignment("center")
        .setBackground("#4a90e2")
        .setFontColor("#ffffff");

      currentRow++;

      // Write data rows for this month
      const dataRows = reportData.map((row) => [
        row.sNo,
        row.date,
        row.week,
        row.maxSlot,
        row.taa,
        row.naa,
        row.oaa,
        row.raa,
        row.old,
        row.new,
        row.wl,
        row.tfa,
        row.capacityPercent + "%",
        row.utilizationPercent + "%",
        row.remainingSlots,
        row.totalAppointments,
        row.loadPercent + "%",
        Utilities.formatDate(
          now,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd HH:mm:ss",
        ),
      ]);

      reportSheet
        .getRange(currentRow, 1, dataRows.length, 18)
        .setValues(dataRows);

      // Apply alternating row colors for better readability
      for (let i = 0; i < dataRows.length; i++) {
        if (i % 2 === 0) {
          reportSheet
            .getRange(currentRow + i, 1, 1, 18)
            .setBackground("#f8f9fa");
        }
      }

      currentRow += dataRows.length;

      // Add month totals row
      const totalsData = [
        "TOTAL (" + metadata.monthName + ")",
        "",
        "",
        totals.maxSlot,
        totals.taa,
        totals.naa,
        totals.oaa,
        totals.raa,
        totals.old,
        totals.new,
        totals.wl,
        totals.tfa,
        averages.capacityPercent + "%",
        averages.utilizationPercent + "%",
        totals.remainingSlots,
        totals.totalAppointments,
        averages.loadPercent + "%",
        "",
      ];

      reportSheet.getRange(currentRow, 1, 1, 18).setValues([totalsData]);
      reportSheet
        .getRange(currentRow, 1, 1, 18)
        .setBackground("#e8f0fe")
        .setFontWeight("bold");

      currentRow++;

      // Add spacing row between months
      if (monthOffset < 2) {
        reportSheet.getRange(currentRow, 1, 1, 18).setBackground("#ffffff");
        currentRow++;
      }

      // Accumulate grand totals
      grandTotals.maxSlot += totals.maxSlot;
      grandTotals.taa += totals.taa;
      grandTotals.naa += totals.naa;
      grandTotals.oaa += totals.oaa;
      grandTotals.raa += totals.raa;
      grandTotals.old += totals.old;
      grandTotals.new += totals.new;
      grandTotals.wl += totals.wl;
      grandTotals.tfa += totals.tfa;
      grandTotals.totalAppointments += totals.totalAppointments;
      grandTotals.remainingSlots += totals.remainingSlots;
      totalDays += dataRows.length;
      totalLoadPercent += averages.loadPercent * dataRows.length;

      allDataRows = allDataRows.concat(dataRows);
    }

    // Add grand totals row for all 3 months
    const avgCapacity =
      grandTotals.maxSlot > 0
        ? Math.round((grandTotals.taa / grandTotals.maxSlot) * 100)
        : 0;
    const avgUtilization =
      grandTotals.maxSlot > 0
        ? Math.round(
            (grandTotals.totalAppointments / grandTotals.maxSlot) * 100,
          )
        : 0;
    const avgLoad =
      totalDays > 0 ? Math.round(totalLoadPercent / totalDays) : 0;

    const grandTotalsData = [
      "🎯 GRAND TOTAL (3 Months)",
      "",
      "",
      grandTotals.maxSlot,
      grandTotals.taa,
      grandTotals.naa,
      grandTotals.oaa,
      grandTotals.raa,
      grandTotals.old,
      grandTotals.new,
      grandTotals.wl,
      grandTotals.tfa,
      avgCapacity + "%",
      avgUtilization + "%",
      grandTotals.remainingSlots,
      grandTotals.totalAppointments,
      avgLoad + "%",
      "",
    ];

    reportSheet.getRange(currentRow, 1, 1, 18).setValues([grandTotalsData]);
    reportSheet
      .getRange(currentRow, 1, 1, 18)
      .setBackground("#4a90e2")
      .setFontColor("#ffffff")
      .setFontWeight("bold")
      .setFontSize(11);

    // Apply borders to entire data range
    reportSheet
      .getRange(1, 1, currentRow, 18)
      .setBorder(
        true,
        true,
        true,
        true,
        true,
        true,
        "#000000",
        SpreadsheetApp.BorderStyle.SOLID,
      );

    // Center align numeric columns (skip header row)
    if (allDataRows.length > 0) {
      reportSheet
        .getRange(2, 1, currentRow - 1, 17)
        .setHorizontalAlignment("center");
    }

    // Auto-resize columns for better fit
    for (let i = 1; i <= 18; i++) {
      reportSheet.autoResizeColumn(i);
    }

    return {
      success: true,
      message: "Monthly report updated successfully for 3 months",
      rowsUpdated: totalDays,
      monthsProcessed: 3,
      lastUpdated: now,
    };
  } catch (e) {
    return {
      success: false,
      message: "Error updating monthly report: " + e.toString(),
    };
  }
}

/**
 * Set up the daily trigger to update monthlyReport sheet at 8 PM
 * This function should be run once to set up the automation
 */
function setupDailyReportTrigger() {
  try {
    // Delete existing triggers for this function to avoid duplicates
    const triggers = ScriptApp.getProjectTriggers();
    for (const trigger of triggers) {
      if (trigger.getHandlerFunction() === "updateMonthlyReportSheet") {
        ScriptApp.deleteTrigger(trigger);
      }
    }

    // Create new trigger for 8 PM daily
    ScriptApp.newTrigger("updateMonthlyReportSheet")
      .timeBased()
      .atHour(20) // 8 PM (20:00 in 24-hour format)
      .everyDays(1)
      .create();

    return {
      success: true,
      message:
        "Daily trigger created successfully. Report will update every day at 8 PM.",
    };
  } catch (e) {
    return {
      success: false,
      message: "Error setting up trigger: " + e.toString(),
    };
  }
}

/**
 * Remove the daily report trigger
 * Use this if you want to stop the automatic updates
 */
function removeDailyReportTrigger() {
  try {
    const triggers = ScriptApp.getProjectTriggers();
    let deletedCount = 0;

    for (const trigger of triggers) {
      if (trigger.getHandlerFunction() === "updateMonthlyReportSheet") {
        ScriptApp.deleteTrigger(trigger);
        deletedCount++;
      }
    }

    return {
      success: true,
      message: "Removed " + deletedCount + " daily trigger(s)",
    };
  } catch (e) {
    return {
      success: false,
      message: "Error removing trigger: " + e.toString(),
    };
  }
}

/**
 * Manual trigger to update the report immediately
 * Can be called from the Apps Script editor or via a custom menu
 */
function manualUpdateMonthlyReport() {
  const result = updateMonthlyReportSheet();
  if (result.success) {
  } else {
  }
  return result;
}

/**
 * ONE-TIME SETUP: Initialize the monthlyReport sheet and set up daily trigger
 * Run this function once from the Apps Script editor to set everything up
 */
function setupMonthlyReportAutomation() {
  try {
    // Step 1: Initialize the sheet
    const sheet = initializeMonthlyReportSheet();

    // Step 2: Run initial update
    const updateResult = updateMonthlyReportSheet();
    if (updateResult.success) {
    } else {
    }

    // Step 3: Set up daily trigger
    const triggerResult = setupDailyReportTrigger();
    if (triggerResult.success) {
    } else {
    }

    return {
      success: true,
      message:
        "Monthly report automation set up successfully. Sheet will update daily at 8 PM.",
      sheetName: sheet.getName(),
      initialRows: updateResult.rowsUpdated || 0,
    };
  } catch (e) {
    return {
      success: false,
      message: "Setup failed: " + e.toString(),
    };
  }
}

// ===========================
// 20-DAY FORECAST CHART
// ===========================

/**
 * Create a chart showing next 20 days forecast with MaxSlot, TAA, and Bookings
 * Chart shows only days where MaxSlot > 0
 * @return {Object} Success/failure response with chart details
 */
function create20DayForecastChart() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const reportSheet = ss.getSheetByName("monthlyReport");

    if (!reportSheet) {
      throw new Error(
        "monthlyReport sheet not found. Run setupMonthlyReportAutomation() first.",
      );
    }

    // Get data for next 20 days starting from today
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const chartData = [];
    const dates = [];

    // Group days by month to minimize data fetching
    const monthsToFetch = new Map(); // Map of "year-month" -> array of days

    for (let dayOffset = 0; dayOffset < 20; dayOffset++) {
      const targetDate = new Date(today);
      targetDate.setDate(today.getDate() + dayOffset);

      const year = targetDate.getFullYear();
      const month = targetDate.getMonth();
      const day = targetDate.getDate();

      const monthKey = year + "-" + month;
      if (!monthsToFetch.has(monthKey)) {
        monthsToFetch.set(monthKey, []);
      }
      monthsToFetch.get(monthKey).push({ year, month, day, date: targetDate });
    }

    // Fetch data for each month once
    for (const [monthKey, days] of monthsToFetch) {
      const year = days[0].year;
      const month = days[0].month;

      const reportResult = generateMonthlyReportData(year, month, null, null);

      if (!reportResult.success || !reportResult.reportData) {
        continue;
      }

      // Process each day in this month
      for (const dayInfo of days) {
        const dayData = reportResult.reportData.find(
          (d) => d.sNo === dayInfo.day,
        );

        if (dayData && dayData.maxSlot > 0) {
          // Only include days with MaxSlot > 0
          const dateLabel =
            String(month + 1).padStart(2, "0") +
            "/" +
            String(dayInfo.day).padStart(2, "0");

          chartData.push({
            date: dateLabel,
            maxSlot: dayData.maxSlot,
            naa: dayData.naa,
            oaa: dayData.oaa,
            taa: dayData.taa,
            new: dayData.new,
            old: dayData.old,
            totalBooking: dayData.totalAppointments,
          });

          dates.push(dateLabel);
        }
      }
    }

    if (chartData.length === 0) {
      return {
        success: false,
        message:
          "No data available for chart. Set MaxSlots for upcoming days first.",
      };
    }

    // Remove existing charts from monthlyReport sheet
    const charts = reportSheet.getCharts();
    charts.forEach((chart) => reportSheet.removeChart(chart));

    // Create chart data sheet (temporary, hidden)
    let chartDataSheet = ss.getSheetByName("_ChartData");
    if (chartDataSheet) {
      ss.deleteSheet(chartDataSheet);
    }
    chartDataSheet = ss.insertSheet("_ChartData");
    chartDataSheet.hideSheet();

    // CHART 1: Summary Chart - MaxSlot vs TAA vs Booking (side by side bars)
    // This is the main comparison chart
    const summaryHeaders = ["Date", "MaxSlot", "TAA", "Booking"];
    chartDataSheet
      .getRange(1, 1, 1, summaryHeaders.length)
      .setValues([summaryHeaders]);

    const summaryRows = chartData.map((d) => [
      d.date,
      d.maxSlot,
      d.taa,
      d.totalBooking,
    ]);

    chartDataSheet
      .getRange(2, 1, summaryRows.length, summaryHeaders.length)
      .setValues(summaryRows);

    // Create the main comparison chart (TAA and Booking side by side)
    const mainChart = reportSheet
      .newChart()
      .setChartType(Charts.ChartType.COMBO)
      .addRange(
        chartDataSheet.getRange(
          1,
          1,
          summaryRows.length + 1,
          summaryHeaders.length,
        ),
      )
      .setPosition(5, 20, 0, 0) // Position: row 5, column 20 (T)
      .setOption("title", "20-Day Forecast: MaxSlot vs TAA vs Bookings")
      .setOption("titleTextStyle", { fontSize: 16, bold: true })
      .setOption("width", 1200)
      .setOption("height", 450)
      .setOption("legend", { position: "top", textStyle: { fontSize: 12 } })
      .setOption("hAxis", {
        title: "Date (MM/DD)",
        titleTextStyle: { fontSize: 12, bold: true },
        textStyle: { fontSize: 10 },
        slantedText: true,
        slantedTextAngle: 45,
      })
      .setOption("vAxis", {
        title: "Count",
        titleTextStyle: { fontSize: 12, bold: true },
        textStyle: { fontSize: 10 },
        minValue: 0,
      })
      .setOption("backgroundColor", "#ffffff")
      .setOption("chartArea", { width: "80%", height: "65%" })

      // Series 0: MaxSlot (Line - gray dashed baseline)
      .setOption("series.0", {
        type: "line",
        color: "#757575",
        lineWidth: 3,
        lineDashStyle: [8, 4],
        pointSize: 6,
        pointShape: "diamond",
      })

      // Series 1: TAA (Column - green)
      .setOption("series.1", {
        type: "bars",
        color: "#4caf50",
      })

      // Series 2: Booking (Column - blue)
      .setOption("series.2", {
        type: "bars",
        color: "#2196f3",
      })

      // Bars side by side (NOT stacked)
      .setOption("isStacked", false)
      .setOption("bar", { groupWidth: "75%" })

      // Legend labels
      .setOption("series.0.labelInLegend", "MaxSlot (Capacity)")
      .setOption("series.1.labelInLegend", "TAA (Allocated)")
      .setOption("series.2.labelInLegend", "Booking with Waiting List")

      .build();

    reportSheet.insertChart(mainChart);

    // CHART 2: Detailed Breakdown Chart - Shows NAA/OAA and NEW/OLD breakdown
    createDetailedBreakdownChart(chartData, reportSheet, ss);

    return {
      success: true,
      message: "20-day forecast chart created successfully",
      daysDisplayed: chartData.length,
      dateRange: dates[0] + " to " + dates[dates.length - 1],
    };
  } catch (e) {
    return {
      success: false,
      message: "Error creating chart: " + e.toString(),
    };
  }
}

/**
 * Create a detailed breakdown chart showing NAA/OAA and NEW/OLD stacked
 * This chart shows the composition of TAA and Bookings
 */
function createDetailedBreakdownChart(chartData, reportSheet, ss) {
  try {
    // Create a second data sheet for the detailed chart
    let detailDataSheet = ss.getSheetByName("_DetailChartData");
    if (detailDataSheet) {
      ss.deleteSheet(detailDataSheet);
    }
    detailDataSheet = ss.insertSheet("_DetailChartData");
    detailDataSheet.hideSheet();

    // Headers: Date | NAA | OAA | NEW | OLD
    const headers = ["Date", "NAA", "OAA", "NEW", "OLD"];
    detailDataSheet.getRange(1, 1, 1, headers.length).setValues([headers]);

    // Write detailed data
    const dataRows = chartData.map((d) => [d.date, d.naa, d.oaa, d.new, d.old]);

    detailDataSheet
      .getRange(2, 1, dataRows.length, headers.length)
      .setValues(dataRows);

    // Create the detailed breakdown chart
    // This shows TAA breakdown (NAA+OAA stacked) and Booking breakdown (NEW+OLD stacked)
    const chart = reportSheet
      .newChart()
      .setChartType(Charts.ChartType.COLUMN)
      .addRange(
        detailDataSheet.getRange(1, 1, dataRows.length + 1, headers.length),
      )
      .setPosition(28, 20, 0, 0) // Position below the first chart
      .setOption(
        "title",
        "Detailed Breakdown: TAA (NAA+OAA) vs Bookings (NEW+OLD)",
      )
      .setOption("titleTextStyle", { fontSize: 14, bold: true })
      .setOption("width", 1200)
      .setOption("height", 400)
      .setOption("legend", { position: "top", textStyle: { fontSize: 11 } })
      .setOption("hAxis", {
        title: "Date (MM/DD)",
        titleTextStyle: { fontSize: 12, bold: true },
        textStyle: { fontSize: 10 },
        slantedText: true,
        slantedTextAngle: 45,
      })
      .setOption("vAxis", {
        title: "Count",
        titleTextStyle: { fontSize: 12, bold: true },
        textStyle: { fontSize: 10 },
        minValue: 0,
      })
      .setOption("backgroundColor", "#ffffff")
      .setOption("chartArea", { width: "80%", height: "60%" })

      // Series 0: NAA (Light green - TAA bottom)
      .setOption("series.0", {
        color: "#a5d6a7",
      })

      // Series 1: OAA (Dark green - TAA top)
      .setOption("series.1", {
        color: "#4caf50",
      })

      // Series 2: NEW (Light blue - Booking bottom)
      .setOption("series.2", {
        color: "#90caf9",
      })

      // Series 3: OLD (Dark blue - Booking top)
      .setOption("series.3", {
        color: "#2196f3",
      })

      // Bars NOT stacked - show all 4 side by side
      .setOption("isStacked", false)
      .setOption("bar", { groupWidth: "80%" })

      // Legend labels
      .setOption("series.0.labelInLegend", "NAA (New Allocated)")
      .setOption("series.1.labelInLegend", "OAA (Old Allocated)")
      .setOption("series.2.labelInLegend", "NEW (with Waiting List)")
      .setOption("series.3.labelInLegend", "OLD (with Waiting List)")

      .build();

    reportSheet.insertChart(chart);
  } catch (e) {}
}

/**
 * Update the monthlyReport sheet with data AND chart
 * This is the enhanced version that includes chart generation
 * @return {Object} Success/failure response
 */
function updateMonthlyReportSheetWithChart() {
  try {
    // First, update the data
    const updateResult = updateMonthlyReportSheet();

    if (!updateResult.success) {
      return updateResult;
    }

    // Then, create/update the chart
    const chartResult = create20DayForecastChart();

    if (!chartResult.success) {
      // Don't fail the whole update if chart fails
      return {
        success: true,
        message: updateResult.message + " (Chart: " + chartResult.message + ")",
        rowsUpdated: updateResult.rowsUpdated,
        monthsProcessed: updateResult.monthsProcessed,
        chartCreated: false,
      };
    }

    return {
      success: true,
      message: updateResult.message + " with 20-day forecast chart",
      rowsUpdated: updateResult.rowsUpdated,
      monthsProcessed: updateResult.monthsProcessed,
      chartCreated: true,
      chartDays: chartResult.daysDisplayed,
      chartDateRange: chartResult.dateRange,
    };
  } catch (e) {
    return {
      success: false,
      message: "Error updating report with chart: " + e.toString(),
    };
  }
}

/**
 * Set up the daily trigger to update monthlyReport sheet with chart at 8 PM
 * This replaces the old trigger with the new chart-enabled version
 */
function setupDailyReportTriggerWithChart() {
  try {
    // Delete existing triggers for both old and new functions
    const triggers = ScriptApp.getProjectTriggers();
    for (const trigger of triggers) {
      const funcName = trigger.getHandlerFunction();
      if (
        funcName === "updateMonthlyReportSheet" ||
        funcName === "updateMonthlyReportSheetWithChart"
      ) {
        ScriptApp.deleteTrigger(trigger);
      }
    }

    // Create new trigger for chart-enabled version
    ScriptApp.newTrigger("updateMonthlyReportSheetWithChart")
      .timeBased()
      .atHour(20) // 8 PM
      .everyDays(1)
      .create();

    return {
      success: true,
      message:
        "Daily trigger created successfully. Report with chart will update every day at 8 PM.",
    };
  } catch (e) {
    return {
      success: false,
      message: "Error setting up trigger: " + e.toString(),
    };
  }
}

/**
 * ONE-TIME SETUP: Initialize the monthlyReport sheet with chart automation
 * Run this function once from the Apps Script editor to set everything up
 */
function setupMonthlyReportAutomationWithChart() {
  try {
    // Step 1: Initialize the sheet
    const sheet = initializeMonthlyReportSheet();

    // Step 2: Run initial update with chart
    const updateResult = updateMonthlyReportSheetWithChart();
    if (updateResult.success) {
      if (updateResult.chartCreated) {
      }
    } else {
    }

    // Step 3: Set up daily trigger with chart
    const triggerResult = setupDailyReportTriggerWithChart();
    if (triggerResult.success) {
    } else {
    }

    return {
      success: true,
      message:
        "Monthly report automation with chart set up successfully. Sheet will update daily at 8 PM.",
      sheetName: sheet.getName(),
      initialRows: updateResult.rowsUpdated || 0,
      chartCreated: updateResult.chartCreated || false,
    };
  } catch (e) {
    return {
      success: false,
      message: "Setup failed: " + e.toString(),
    };
  }
}

// ===========================
// SETTINGS STORAGE INFRASTRUCTURE
// ===========================

/**
 * Initializes or ensures the Settings sheet exists with proper headers
 * Columns: SettingKey, SettingValue, LastModified, ModifiedBy
 * @return {Sheet} The Settings sheet
 */
function initializeSettingsSheet() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let settingsSheet = ss.getSheetByName("Settings");

    if (!settingsSheet) {
      settingsSheet = ss.insertSheet("Settings");
      const headers = [
        "SettingKey",
        "SettingValue",
        "LastModified",
        "ModifiedBy",
      ];
      settingsSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      settingsSheet.setFrozenRows(1);
    }

    return settingsSheet;
  } catch (e) {
    throw e;
  }
}

/**
 * Reads a setting value from the Settings sheet
 * @param {string} settingKey - The unique key for the setting
 * @param {*} defaultValue - Default value to return if setting not found
 * @return {*} The setting value or default value
 */
function readSetting(settingKey, defaultValue) {
  try {
    const settingsSheet = initializeSettingsSheet();
    const data = settingsSheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === settingKey) {
        return data[i][1];
      }
    }

    return defaultValue;
  } catch (e) {
    return defaultValue;
  }
}

/**
 * Writes a setting value to the Settings sheet
 * @param {string} settingKey - The unique key for the setting
 * @param {*} settingValue - The value to store
 * @param {string} modifiedBy - Username of the person making the change
 * @return {boolean} True if successful
 */
function writeSetting(settingKey, settingValue, modifiedBy) {
  try {
    const settingsSheet = initializeSettingsSheet();
    const data = settingsSheet.getDataRange().getValues();
    const now = new Date();

    // Check if setting already exists
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === settingKey) {
        // Update existing setting
        settingsSheet.getRange(i + 1, 2).setValue(settingValue);
        settingsSheet.getRange(i + 1, 3).setValue(now);
        settingsSheet.getRange(i + 1, 4).setValue(modifiedBy);
        return true;
      }
    }

    // Add new setting
    const newRow = [settingKey, settingValue, now, modifiedBy];
    settingsSheet.appendRow(newRow);
    return true;
  } catch (e) {
    return false;
  }
}

// ===========================
// EARLY BOOKING SETTINGS
// ===========================

// Setting key for multi-threshold early booking restrictions
const EARLY_BOOKING_THRESHOLDS_KEY = "EARLY_BOOKING_THRESHOLDS";

// Default thresholds for multi-threshold system
const DEFAULT_THRESHOLDS = [
  { days: 10, percentage: 51 },
  { days: 5,  percentage: 79 },
  { days: 4,  percentage: 85 },
  { days: 1,  percentage: 95 },
  { days: 0,  percentage: 100 },
];

// ===========================
// DEFAULT WEEKLY MAXSLOTS SETTINGS
// ===========================

// Setting key for default weekly maxSlots configuration
const DEFAULT_WEEKLY_MAXSLOTS_KEY = "DEFAULT_WEEKLY_MAXSLOTS";

// Default weekly maxSlots values (Sunday=0, Monday=1, ..., Saturday=6)
const DEFAULT_WEEKLY_MAXSLOTS = {
  0: 0, // Sunday - no slots
  1: 38, // Monday
  2: 0, // Tuesday - no slots
  3: 38, // Wednesday
  4: 38, // Thursday
  5: 15, // Friday
  6: 38, // Saturday
};

// ===========================
// WAITING LIST PERCENTAGE SETTINGS
// ===========================

// Setting key for waiting list percentage configuration
const WAITING_LIST_PERCENTAGE_KEY = "WAITING_LIST_PERCENTAGE";

// Default waiting list percentage (15% of MaxSlots)
const DEFAULT_WAITING_LIST_PERCENTAGE = 15;

/**
 * Retrieves the current multi-threshold early booking restriction settings
 * Returns default values if settings are not configured
 * @return {Object} Object containing success status and array of thresholds
 */
function getEarlyBookingSettings() {
  try {
    const thresholdsJson = readSetting(EARLY_BOOKING_THRESHOLDS_KEY, null);

    if (!thresholdsJson) {
      // No settings found, return defaults
      return {
        success: true,
        thresholds: DEFAULT_THRESHOLDS,
      };
    }

    // Parse JSON string to array
    const thresholds = JSON.parse(thresholdsJson);

    // Validate that it's an array with proper structure
    if (!Array.isArray(thresholds) || thresholds.length === 0) {
      return {
        success: true,
        thresholds: DEFAULT_THRESHOLDS,
      };
    }

    // Validate each threshold has days and percentage
    for (let i = 0; i < thresholds.length; i++) {
      if (
        typeof thresholds[i].days !== "number" ||
        typeof thresholds[i].percentage !== "number"
      ) {
        return {
          success: true,
          thresholds: DEFAULT_THRESHOLDS,
        };
      }
    }

    return {
      success: true,
      thresholds: thresholds,
    };
  } catch (e) {
    return {
      success: true,
      thresholds: DEFAULT_THRESHOLDS,
    };
  }
}

/**
 * Saves the multi-threshold early booking restriction settings
 * Requires admin access (Level 1) to save
 * @param {Object} settings - Object containing thresholds array
 * @param {string} sessionToken - User session token for authentication
 * @return {Object} Object containing success status and message
 */
function saveEarlyBookingSettings(settings, sessionToken) {
  try {
    // Validate session token
    const session = getUserSession(sessionToken);
    if (!session) {
      return {
        success: false,
        message: "Authentication required to modify settings",
      };
    }

    // Check admin access (Level 1)
    if (!isLevel1(sessionToken)) {
      return {
        success: false,
        message: "Admin privileges required to modify settings",
      };
    }

    const { thresholds } = settings;

    // Validate thresholds is an array
    if (!Array.isArray(thresholds) || thresholds.length === 0) {
      return {
        success: false,
        message: "Thresholds must be a non-empty array",
      };
    }

    // Validate each threshold
    for (let i = 0; i < thresholds.length; i++) {
      const threshold = thresholds[i];

      // Validate structure
      if (
        !threshold.hasOwnProperty("days") ||
        !threshold.hasOwnProperty("percentage")
      ) {
        return {
          success: false,
          message:
            "Each threshold must have 'days' and 'percentage' properties",
        };
      }

      // Validate percentage is between 10-100
      const percentage = parseInt(threshold.percentage, 10);
      if (isNaN(percentage) || percentage < 10 || percentage > 100) {
        return {
          success: false,
          message: "Each percentage must be between 10 and 100",
        };
      }

      // Update the threshold with parsed value
      thresholds[i].percentage = percentage;
    }

    // Validate percentages increase as days decrease
    // Sort by days descending to check ordering
    const sortedThresholds = thresholds.slice().sort((a, b) => b.days - a.days);
    for (let i = 0; i < sortedThresholds.length - 1; i++) {
      if (sortedThresholds[i].percentage > sortedThresholds[i + 1].percentage) {
        return {
          success: false,
          message:
            "Percentages must increase as days decrease (e.g., 50% ≤ 85% ≤ 95% ≤ 100%)",
        };
      }
    }

    const username = session.username;

    // Convert thresholds array to JSON string
    const thresholdsJson = JSON.stringify(thresholds);

    // Save settings
    const result = writeSetting(
      EARLY_BOOKING_THRESHOLDS_KEY,
      thresholdsJson,
      username,
    );

    if (result) {
      return {
        success: true,
        message: "Early booking settings saved successfully",
      };
    } else {
      return {
        success: false,
        message: "Failed to save settings",
      };
    }
  } catch (e) {
    return {
      success: false,
      message: "Error saving settings: " + e.toString(),
    };
  }
}

// ===========================
// DEFAULT WEEKLY MAXSLOTS FUNCTIONS
// ===========================

/**
 * Retrieves the default weekly maxSlots configuration
 * Returns default values if settings are not configured
 * @return {Object} Object containing success status and weekly maxSlots object
 */
function getDefaultWeeklyMaxSlots() {
  try {
    const settingsJson = readSetting(DEFAULT_WEEKLY_MAXSLOTS_KEY, null);

    if (!settingsJson) {
      // No settings found, return defaults
      return {
        success: true,
        weeklyMaxSlots: DEFAULT_WEEKLY_MAXSLOTS,
      };
    }

    // Parse JSON string to object
    const weeklyMaxSlots = JSON.parse(settingsJson);

    // Validate that it's an object with all 7 days (0-6)
    if (typeof weeklyMaxSlots !== "object" || weeklyMaxSlots === null) {
      return {
        success: true,
        weeklyMaxSlots: DEFAULT_WEEKLY_MAXSLOTS,
      };
    }

    // Validate each day has a non-negative integer value
    for (let day = 0; day <= 6; day++) {
      const value = weeklyMaxSlots[day];
      if (typeof value !== "number" || value < 0 || !Number.isInteger(value)) {
        return {
          success: true,
          weeklyMaxSlots: DEFAULT_WEEKLY_MAXSLOTS,
        };
      }
    }

    return {
      success: true,
      weeklyMaxSlots: weeklyMaxSlots,
    };
  } catch (e) {
    return {
      success: true,
      weeklyMaxSlots: DEFAULT_WEEKLY_MAXSLOTS,
    };
  }
}

/**
 * Saves the default weekly maxSlots configuration
 * Requires admin access (Level 1) to save
 * @param {Object} settings - Object containing weeklyMaxSlots object
 * @param {string} sessionToken - User session token for authentication
 * @return {Object} Object containing success status and message
 */
function saveDefaultWeeklyMaxSlots(settings, sessionToken) {
  try {
    // Validate session token
    const session = getUserSession(sessionToken);
    if (!session) {
      return {
        success: false,
        message: "Authentication required to modify settings",
      };
    }

    // Check admin access (Level 1)
    if (!isLevel1(sessionToken)) {
      return {
        success: false,
        message: "Admin privileges required to modify settings",
      };
    }

    const { weeklyMaxSlots } = settings;

    // Validate weeklyMaxSlots is an object
    if (typeof weeklyMaxSlots !== "object" || weeklyMaxSlots === null) {
      return {
        success: false,
        message: "weeklyMaxSlots must be a valid object",
      };
    }

    // Validate all 7 days are present with valid values
    for (let day = 0; day <= 6; day++) {
      if (!weeklyMaxSlots.hasOwnProperty(day.toString())) {
        return {
          success: false,
          message: "weeklyMaxSlots must contain all days (0-6)",
        };
      }

      const value = parseInt(weeklyMaxSlots[day.toString()], 10);
      if (isNaN(value) || value < 0) {
        return {
          success: false,
          message:
            "Each day's maxSlots must be a non-negative integer (day " +
            day +
            " is invalid)",
        };
      }

      // Convert to integer
      weeklyMaxSlots[day.toString()] = value;
    }

    // Get username for audit trail
    const username = session.username || "Unknown";

    // Save settings as JSON string
    const settingsJson = JSON.stringify(weeklyMaxSlots);
    const success = writeSetting(
      DEFAULT_WEEKLY_MAXSLOTS_KEY,
      settingsJson,
      username,
    );

    if (success) {
      return {
        success: true,
        message: "Default weekly maxSlots settings saved successfully",
      };
    } else {
      return {
        success: false,
        message: "Failed to save settings to database",
      };
    }
  } catch (e) {
    return {
      success: false,
      message: "Error saving settings: " + e.toString(),
    };
  }
}

// ===========================
// WAITING LIST PERCENTAGE FUNCTIONS
// ===========================

/**
 * Retrieves the current waiting list percentage configuration
 * Returns default value if settings are not configured
 * @return {Object} Object containing success status and percentage value
 */
function getWaitingListPercentage() {
  try {
    const percentageJson = readSetting(WAITING_LIST_PERCENTAGE_KEY, null);

    if (!percentageJson) {
      // No settings found, return default
      return {
        success: true,
        percentage: DEFAULT_WAITING_LIST_PERCENTAGE,
      };
    }

    // Parse JSON string to get settings object
    const settings = JSON.parse(percentageJson);

    // Validate that it's an object with percentage property
    if (
      typeof settings !== "object" ||
      settings === null ||
      typeof settings.percentage !== "number"
    ) {
      return {
        success: true,
        percentage: DEFAULT_WAITING_LIST_PERCENTAGE,
      };
    }

    // Validate percentage is within reasonable range (1-50)
    const percentage = parseInt(settings.percentage, 10);
    if (isNaN(percentage) || percentage < 1 || percentage > 50) {
      return {
        success: true,
        percentage: DEFAULT_WAITING_LIST_PERCENTAGE,
      };
    }

    return {
      success: true,
      percentage: percentage,
    };
  } catch (e) {
    return {
      success: true,
      percentage: DEFAULT_WAITING_LIST_PERCENTAGE,
    };
  }
}

/**
 * Saves the waiting list percentage configuration
 * Requires admin access (Level 1) to save
 * @param {Object} settings - Object containing percentage value
 * @param {string} sessionToken - User session token for authentication
 * @return {Object} Object containing success status and message
 */
function saveWaitingListPercentage(settings, sessionToken) {
  try {
    // Validate session token
    const session = getUserSession(sessionToken);
    if (!session) {
      return {
        success: false,
        message: "Authentication required to modify settings",
      };
    }

    // Check admin access (Level 1)
    if (!isLevel1(sessionToken)) {
      return {
        success: false,
        message: "Admin privileges required to modify settings",
      };
    }

    const { percentage } = settings;

    // Validate percentage is provided
    if (typeof percentage === "undefined" || percentage === null) {
      return {
        success: false,
        message: "Percentage value is required",
      };
    }

    // Validate percentage is a number between 1-50
    const percentageValue = parseInt(percentage, 10);
    if (isNaN(percentageValue) || percentageValue < 1 || percentageValue > 50) {
      return {
        success: false,
        message: "Percentage must be between 1 and 50",
      };
    }

    // Get username for audit trail
    const username = session.username || "Unknown";

    // Create settings object with validated percentage
    const settingsObj = {
      percentage: percentageValue,
    };

    // Save settings as JSON string
    const settingsJson = JSON.stringify(settingsObj);
    const success = writeSetting(
      WAITING_LIST_PERCENTAGE_KEY,
      settingsJson,
      username,
    );

    if (success) {
      return {
        success: true,
        message: "Waiting list percentage settings saved successfully",
      };
    } else {
      return {
        success: false,
        message: "Error saving waiting list percentage settings",
      };
    }
  } catch (e) {
    return {
      success: false,
      message: "Error saving settings: " + e.toString(),
    };
  }
}

// ===========================
// AUTO-UPDATE PLANNINGB MAXSLOTS LOGIC
// ===========================

/**
 * Automatically updates maxSlots in planningB for future dates
 * - Processes dates from today to 90 days in future
 * - Only updates rows where maxSlots = 0 (preserves manual settings)
 * - Uses day-of-week to determine default maxSlots
 * - Marks updates as "System (Auto-Update)" in edit tracking
 * Called by daily trigger at 2 AM
 */
function autoUpdatePlanningBMaxSlots() {
  try {
    const planningBSheet = initializePlanningBSheet();

    // Get default weekly maxSlots configuration
    const settingsResult = getDefaultWeeklyMaxSlots();
    if (!settingsResult.success) {
      Logger.log("Failed to get default weekly maxSlots settings");
      return { success: false, message: "Failed to get settings" };
    }

    const weeklyMaxSlots = settingsResult.weeklyMaxSlots;

    // Calculate date range: today to today + 90 days
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Reset to midnight

    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + 90);

    // Get current planningB data
    const data = planningBSheet.getDataRange().getValues();
    const existingDates = new Map(); // dateStr -> {rowIndex, maxSlots}

    // Build map of existing dates
    for (let i = 1; i < data.length; i++) {
      let dateValue = data[i][0];
      if (!dateValue) continue;

      let dateStr = "";
      if (dateValue instanceof Date) {
        dateStr = Utilities.formatDate(
          dateValue,
          Session.getScriptTimeZone(),
          "yyyy-MM-dd",
        );
      } else {
        dateStr = dateValue.toString().trim();
      }

      if (dateStr) {
        existingDates.set(dateStr, {
          rowIndex: i + 1, // 1-indexed
          maxSlots: parseInt(data[i][1]) || 0,
        });
      }
    }

    // Process each date in range
    let updatedCount = 0;
    let skippedCount = 0;
    const currentDate = new Date(today);

    while (currentDate <= endDate) {
      const dateStr = Utilities.formatDate(
        currentDate,
        Session.getScriptTimeZone(),
        "yyyy-MM-dd",
      );
      const dayOfWeek = currentDate.getDay(); // 0=Sunday, 6=Saturday
      const defaultMaxSlots = weeklyMaxSlots[dayOfWeek];

      // Check if date exists in planningB
      if (existingDates.has(dateStr)) {
        // Date exists - only update if maxSlots is 0
        const existing = existingDates.get(dateStr);
        if (existing.maxSlots === 0 && defaultMaxSlots > 0) {
          // Update existing row with maxSlots = 0
          updateMaxSlotsAutomatic(
            dateStr,
            defaultMaxSlots,
            existing.rowIndex,
            planningBSheet,
          );
          updatedCount++;
        } else {
          // Skip: either maxSlots > 0 (manual setting) or default is also 0
          skippedCount++;
        }
      } else {
        // Date doesn't exist - only create if default > 0
        if (defaultMaxSlots > 0) {
          addNewMaxSlotsAutomatic(dateStr, defaultMaxSlots, planningBSheet);
          updatedCount++;
        }
      }

      // Move to next day
      currentDate.setDate(currentDate.getDate() + 1);
    }

    Logger.log(
      "Auto-update completed: " +
        updatedCount +
        " dates updated, " +
        skippedCount +
        " dates skipped",
    );

    return {
      success: true,
      message: "Auto-update completed successfully",
      updatedCount: updatedCount,
      skippedCount: skippedCount,
    };
  } catch (e) {
    Logger.log("Error in autoUpdatePlanningBMaxSlots: " + e.toString());
    return {
      success: false,
      message: "Error during auto-update: " + e.toString(),
    };
  }
}

/**
 * Helper function to update an existing row in planningB with automatic update
 * @param {string} dateStr - Date in yyyy-MM-dd format
 * @param {number} maxSlots - New maxSlots value
 * @param {number} rowIndex - Row index in sheet (1-indexed)
 * @param {Sheet} planningBSheet - The planningB sheet object
 */
function updateMaxSlotsAutomatic(dateStr, maxSlots, rowIndex, planningBSheet) {
  try {
    const editorName = "System (Auto-Update)";
    const editTime = Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone(),
      "yyyy-MM-dd HH:mm:ss",
    );

    // Calculate stats
    const stats = calculateAppointmentStats(dateStr);
    const raa = Math.max(0, maxSlots - stats.taa);

    // Get existing history
    const existingHistory =
      planningBSheet.getRange(rowIndex, 9).getValue() || "";
    const newHistoryEntry = editorName + " set " + maxSlots + " on " + editTime;
    const updatedHistory = existingHistory
      ? existingHistory + " | " + newHistoryEntry
      : newHistoryEntry;

    // Update row
    planningBSheet.getRange(rowIndex, 2).setValue(maxSlots); // maxSlots
    planningBSheet.getRange(rowIndex, 3).setValue(stats.naa); // NAA
    planningBSheet.getRange(rowIndex, 4).setValue(stats.oaa); // OAA
    planningBSheet.getRange(rowIndex, 5).setValue(stats.taa); // TAA
    planningBSheet.getRange(rowIndex, 6).setValue(raa); // RAA
    planningBSheet.getRange(rowIndex, 7).setValue(editorName); // maxSlots edited by
    planningBSheet.getRange(rowIndex, 8).setValue(editTime); // maxSlots edited on
    planningBSheet.getRange(rowIndex, 9).setValue(updatedHistory); // maxSlot edit history

    // Sync with planningA (maxSlots > 0, so ensure date exists)
    ensureDateInPlanningA(dateStr);
  } catch (e) {
    Logger.log(
      "Error updating row " +
        rowIndex +
        " for date " +
        dateStr +
        ": " +
        e.toString(),
    );
  }
}

/**
 * Helper function to add a new row to planningB with automatic update
 * @param {string} dateStr - Date in yyyy-MM-dd format
 * @param {number} maxSlots - MaxSlots value
 * @param {Sheet} planningBSheet - The planningB sheet object
 */
function addNewMaxSlotsAutomatic(dateStr, maxSlots, planningBSheet) {
  try {
    const editorName = "System (Auto-Update)";
    const editTime = Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone(),
      "yyyy-MM-dd HH:mm:ss",
    );

    // Calculate stats
    const stats = calculateAppointmentStats(dateStr);
    const raa = Math.max(0, maxSlots - stats.taa);

    // Create history entry
    const historyEntry = editorName + " set " + maxSlots + " on " + editTime;

    // Append new row
    const newRow = [
      dateStr,
      maxSlots,
      stats.naa,
      stats.oaa,
      stats.taa,
      raa,
      editorName,
      editTime,
      historyEntry,
    ];
    planningBSheet.appendRow(newRow);

    // Sync with planningA (maxSlots > 0, so ensure date exists)
    ensureDateInPlanningA(dateStr);
  } catch (e) {
    Logger.log(
      "Error adding new row for date " + dateStr + ": " + e.toString(),
    );
  }
}

// ===========================
// EARLY BOOKING RESTRICTION HELPERS
// ===========================

/**
 * Custom rounding function for percentage calculations
 * If decimal part > 0.5: round up (Math.ceil)
 * If decimal part ≤ 0.5: round down (Math.floor)
 * @param {number} value - The decimal value to round
 * @return {number} The rounded value
 */
function customRound(value) {
  const decimal = value - Math.floor(value);
  return decimal > 0.5 ? Math.ceil(value) : Math.floor(value);
}

/**
 * Determines which threshold applies based on days until appointment
 * @param {number} daysUntilAppointment - Days from today to appointment date
 * @param {Array} allThresholds - Array of threshold objects sorted by days descending
 * @return {Object} Threshold object with days and percentage properties
 */
function selectThreshold(daysUntilAppointment, allThresholds) {
  // Sort thresholds by days in descending order to ensure proper selection
  const sortedThresholds = allThresholds
    .slice()
    .sort((a, b) => b.days - a.days);

  // Find the first threshold where daysUntilAppointment >= threshold.days
  for (let i = 0; i < sortedThresholds.length; i++) {
    if (daysUntilAppointment >= sortedThresholds[i].days) {
      return sortedThresholds[i];
    }
  }

  // If no threshold matches (shouldn't happen with proper defaults), return the lowest threshold
  return sortedThresholds[sortedThresholds.length - 1];
}

/**
 * Calculates the number of calendar days from today to the given date
 * Returns 0 for today, 1 for tomorrow, etc.
 * @param {string} dateStr - Date in "yyyy-MM-dd" format
 * @return {number} Number of calendar days until the appointment date
 */
function calculateDaysUntil(dateStr) {
  try {
    // Parse the target date
    const targetDate = new Date(dateStr + "T00:00:00");
    if (isNaN(targetDate.getTime())) {
      return 0;
    }

    // Get today's date at midnight
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Calculate the difference in milliseconds
    const diffMs = targetDate.getTime() - today.getTime();

    // Convert to days (round to handle any timezone issues)
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

    return diffDays;
  } catch (e) {
    return 0;
  }
}

/**
 * Calculates the TAA percentage for a given date
 * TAA percentage = (TAA / maxSlots) * 100
 * Excludes waiting list appointments from TAA count
 * Uses custom rounding rule (decimals > 0.5 round up, ≤ 0.5 truncate)
 * @param {string} dateStr - Date in "yyyy-MM-dd" format
 * @return {Object} Object containing taa, maxSlots, and percentageUsed
 */
function calculateTAAPercentage(dateStr) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const appointmentSheet = ss.getSheetByName("appointment");

    // Calculate TAA excluding waiting list appointments
    let taa = 0;

    if (appointmentSheet) {
      const data = appointmentSheet.getDataRange().getValues();
      const headers = data[0];

      // Find column indices
      const dateColIndex = headers.indexOf("AppointmentDate");
      const timeSlotColIndex = headers.indexOf("TimeSlot");
      const mrdColIndex = headers.indexOf("MRDNo");
      const typeColIndex = headers.indexOf("AppointmentType");
      const deletedOnIndex = headers.indexOf("Deleted On");

      if (
        dateColIndex !== -1 &&
        timeSlotColIndex !== -1 &&
        mrdColIndex !== -1
      ) {
        for (let i = 1; i < data.length; i++) {
          const row = data[i];

          // Skip deleted appointments
          if (deletedOnIndex !== -1 && row[deletedOnIndex]) {
            continue;
          }

          // Check date
          const appointmentDate = row[dateColIndex];
          let rowDateStr = "";

          if (appointmentDate instanceof Date) {
            rowDateStr = Utilities.formatDate(
              appointmentDate,
              Session.getScriptTimeZone(),
              "yyyy-MM-dd",
            );
          } else if (appointmentDate) {
            rowDateStr = appointmentDate.toString().trim();
            // Handle potential date format issues
            if (rowDateStr.includes("/")) {
              const parts = rowDateStr.split("/");
              if (parts.length === 3) {
                const tempDate = new Date(rowDateStr);
                if (!isNaN(tempDate.getTime())) {
                  rowDateStr = Utilities.formatDate(
                    tempDate,
                    Session.getScriptTimeZone(),
                    "yyyy-MM-dd",
                  );
                }
              }
            }
          }

          if (rowDateStr !== dateStr) {
            continue;
          }

          // Skip waiting list appointments
          if (typeColIndex !== -1) {
            const appointmentType = row[typeColIndex]
              ? row[typeColIndex].toString().trim().toUpperCase()
              : "";
            if (appointmentType === "WAITING LIST") {
              continue;
            }
          }

          // Check if time slot has a value
          const timeSlot = row[timeSlotColIndex];
          if (!timeSlot || timeSlot.toString().trim() === "") {
            continue;
          }

          // Get MRD No and check first letter
          const mrdNo = row[mrdColIndex];
          if (!mrdNo) {
            continue;
          }

          const mrdStr = mrdNo.toString().trim().toUpperCase();

          // Count appointments starting with N or S
          if (mrdStr.startsWith("N") || mrdStr.startsWith("S")) {
            taa++;
          }
        }
      }
    }

    // Get maxSlots from PlanningB sheet
    let maxSlots = 0;
    const planningBSheet = ss.getSheetByName("planningB");

    if (planningBSheet) {
      const data = planningBSheet.getDataRange().getValues();

      for (let i = 1; i < data.length; i++) {
        let existingDate = data[i][0];
        if (existingDate instanceof Date) {
          existingDate = Utilities.formatDate(
            existingDate,
            Session.getScriptTimeZone(),
            "yyyy-MM-dd",
          );
        } else if (existingDate) {
          existingDate = existingDate.toString().trim();
        }

        if (existingDate === dateStr) {
          maxSlots = data[i][1] || 0;
          break;
        }
      }
    }

    // Calculate percentage (handle maxSlots = 0 or undefined gracefully)
    let percentageUsed = 0;
    if (maxSlots > 0) {
      const rawPercentage = (taa / maxSlots) * 100;
      percentageUsed = customRound(rawPercentage);
    }

    return {
      taa: taa,
      maxSlots: maxSlots,
      percentageUsed: percentageUsed,
    };
  } catch (e) {
    return {
      taa: 0,
      maxSlots: 0,
      percentageUsed: 0,
    };
  }
}

// =============================================
// DASHBOARD IMPROVEMENT FUNCTIONS
// =============================================

/**
 * Gets slot availability forecast for the next 7 working days
 * @return {Object} Forecast data with daily slot breakdown
 */
function getSevenDayForecast() {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Build next 7 working days (skip Sundays)
    const workDays = [];
    let cursor = new Date(today);
    cursor.setDate(cursor.getDate() + 1); // Start from tomorrow

    while (workDays.length < 7) {
      if (cursor.getDay() !== 0) {
        // Skip Sundays
        workDays.push(new Date(cursor));
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    const forecast = [];

    workDays.forEach(function (day, index) {
      const dateStr = Utilities.formatDate(
        day,
        Session.getScriptTimeZone(),
        "yyyy-MM-dd",
      );
      const dayName = Utilities.formatDate(
        day,
        Session.getScriptTimeZone(),
        "EEEE",
      );

      // Get slot status for this date
      const slotStatus = getSlotStatusForDate(dateStr);

      const maxSlots = slotStatus.maxSlots || 0;
      const taa = slotStatus.taa || 0;
      const naa = slotStatus.naa || 0;
      const oaa = slotStatus.oaa || 0;
      const raa = slotStatus.raa || 0;

      // Get waiting list count for this date
      const wlResult = getWaitingListCount(dateStr);
      const wl = wlResult.success ? wlResult.count || 0 : 0;

      const utilization = maxSlots > 0 ? Math.round((taa / maxSlots) * 100) : 0;

      let status = "available";
      if (utilization >= 100) {
        status = "full";
      } else if (utilization >= 80) {
        status = "low";
      }

      forecast.push({
        date: dateStr,
        dayName: dayName,
        dayNumber: index + 1,
        maxSlots: maxSlots,
        naa: naa,
        oaa: oaa,
        taa: taa,
        raa: raa,
        wl: wl,
        utilization: utilization,
        status: status,
      });
    });

    // Calculate summary stats
    let totalRaa = 0;
    let totalNaa = 0;
    let totalOaa = 0;
    let overbookedDays = 0;

    forecast.forEach(function (day) {
      totalRaa += day.raa;
      totalNaa += day.naa;
      totalOaa += day.oaa;
      if (day.utilization >= 100) {
        overbookedDays++;
      }
    });

    return {
      success: true,
      forecast: forecast,
      summary: {
        totalAvailableSlots: totalRaa,
        totalNewPatientSlots: totalNaa,
        totalOldPatientSlots: totalOaa,
        overbookedDays: overbookedDays,
      },
    };
  } catch (e) {
    return {
      success: false,
      error: e.toString(),
      forecast: [],
      summary: {
        totalAvailableSlots: 0,
        totalNewPatientSlots: 0,
        totalOldPatientSlots: 0,
        overbookedDays: 0,
      },
    };
  }
}

/**
 * Gets capacity data for heatmap visualization
 * @param {number} year - Year to fetch
 * @param {number} month - Month (0-indexed) to fetch
 * @return {Object} Heatmap data with daily utilization
 */
function getCapacityHeatmapData(year, month) {
  try {
    // Leverage existing getPlanningBDataForMonth function (uses 0-indexed months)
    const planningData = getPlanningBDataForMonth(year, month);

    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const heatmapData = [];

    for (let day = 1; day <= daysInMonth; day++) {
      const dayData =
        planningData.success && planningData.data && planningData.data[day]
          ? planningData.data[day]
          : { maxSlots: 0, taa: 0, raa: 0 };

      const maxSlots = dayData.maxSlots || 0;
      const booked = dayData.taa || 0;
      const available = dayData.raa || 0;

      const utilization =
        maxSlots > 0 ? Math.round((booked / maxSlots) * 100) : 0;

      const date = new Date(year, month, day);
      heatmapData.push({
        day: day,
        dayOfWeek: date.getDay(),
        utilization: utilization,
        maxSlots: maxSlots,
        booked: booked,
        available: available,
        isSunday: date.getDay() === 0,
      });
    }

    return {
      success: true,
      year: year,
      month: month,
      data: heatmapData,
    };
  } catch (e) {
    return {
      success: false,
      error: e.toString(),
      year: year,
      month: month,
      data: [],
    };
  }
}

/**
 * Gets comprehensive staff analytics - ADMIN ONLY
 * @param {string} sessionToken - Session token for access control
 * @param {string} fromDate - Start date (YYYY-MM-DD)
 * @param {string} toDate - End date (YYYY-MM-DD)
 * @return {Object} Staff performance data
 */
function getStaffAnalytics(sessionToken, fromDate, toDate) {
  try {
    // Access control check
    if (!hasAdminAccess(sessionToken)) {
      return {
        success: false,
        error: "Access denied. Admin privileges required.",
      };
    }

    // Get booking analytics (existing function)
    let bookingData = { success: false, data: {} };
    try {
      bookingData = getBookingAnalytics(fromDate, toDate);
    } catch (e) {
      // Function may not exist, continue with empty data
    }

    // Get rescheduling stats (existing function)
    let rescheduleStats = {
      totalReschedules: 0,
      highRiskAppointments: 0,
      averageReschedulesPerAppointment: 0,
    };
    try {
      rescheduleStats = getReschedulingStats();
    } catch (e) {
      // Function may not exist, continue with empty data
    }

    // Get detailed rescheduling analytics
    let rescheduleAnalytics = {
      reschedulesByStaff: {},
      reschedulesByMonth: {},
    };
    try {
      rescheduleAnalytics = getReschedulingAnalytics();
    } catch (e) {
      // Function may not exist, continue with empty data
    }

    // Find top booker
    let topBooker = "-";
    let maxBookings = 0;
    if (bookingData.success && bookingData.data) {
      for (var staff in bookingData.data) {
        if (bookingData.data.hasOwnProperty(staff)) {
          var count = bookingData.data[staff];
          if (count > maxBookings) {
            maxBookings = count;
            topBooker = staff;
          }
        }
      }
    }

    return {
      success: true,
      bookingData: bookingData,
      rescheduleStats: rescheduleStats,
      rescheduleAnalytics: rescheduleAnalytics,
      topBooker: topBooker,
      topBookerCount: maxBookings,
    };
  } catch (e) {
    return {
      success: false,
      error: e.toString(),
    };
  }
}

// ============================================================
// RULE SETTINGS — Phase 1 (Foundation)
// ============================================================

var ruleSettingsCache_ = null;   // Private module-level cache

/**
 * Create the RuleSettings sheet with all 35 default values.
 * Run once manually or via setup trigger.
 * Does NOT overwrite existing sheet — safe to call multiple times.
 */
function initializeRuleSettingsSheet() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("RuleSettings");
    if (sheet) {
      Logger.log("RuleSettings sheet already exists — skipping initialisation.");
      return true;
    }
    sheet = ss.insertSheet("RuleSettings");

    var headers = ["ruleKey", "ruleName", "value", "description"];
    sheet.getRange(1, 1, 1, 4).setValues([headers]);

    var defaults = [
      ["NEW_MORNING_START",          "New Patient Morning Start",           "10:00",    "New patients only from this time (HH:MM, 24h)"],
      ["NEW_EVENING_CUTOFF",         "New Patient Evening Cutoff",          "16:00",    "No new patients after this time (HH:MM, 24h)"],
      ["NEW_CONSECUTIVE_GAP",        "Consecutive New Patient Gap",         "30",       "Max gap (minutes) between two new patients to flag"],
      ["FAMILY_MORNING_CUTOFF",      "Family Morning Cutoff",               "11:30",    "Flag family members scheduled before this (HH:MM, 24h)"],
      ["FAMILY_MORNING_MAX",         "Family Morning Max Members",          "3",        "Max family members allowed in morning slots"],
      ["CONSULT_WINDOW_START",       "Consult Window Morning Start",        "10:30",    "Consultation window begins (HH:MM, 24h)"],
      ["CONSULT_WINDOW_LUNCH_START", "Lunch Break Start",                   "13:30",    "Lunch break begins (HH:MM, 24h)"],
      ["CONSULT_WINDOW_LUNCH_END",   "Lunch Break End",                     "14:30",    "Lunch break ends (HH:MM, 24h)"],
      ["CONSULT_WINDOW_END",         "Consult Window Evening End",          "17:30",    "Consultation window ends (HH:MM, 24h)"],
      ["HFA_SLOT_1",                 "HFA Reserved Slot 1",                 "09:20",    "First HFA reserved time slot (HH:MM, 24h)"],
      ["HFA_SLOT_2",                 "HFA Reserved Slot 2",                 "09:40",    "Second HFA reserved time slot (HH:MM, 24h)"],
      ["ROP_DAY",                    "ROP Day of Week",                     "WED",      "ROP appointments allowed only on this day (SUN-SAT)"],
      ["LASER_DAYS",                 "Laser Days of Week",                  "TUE,FRI",  "Laser allowed only on these days (comma-sep, SUN-SAT)"],
      ["LASER_DURATION",             "Laser Min Gap",                       "20",       "Minimum gap (minutes) required for laser procedures"],
      ["WHEELCHAIR_MORNING_END",     "Wheelchair Morning End",              "10:00",    "Wheelchair patients before this time OK (HH:MM, 24h)"],
      ["WHEELCHAIR_EVENING_START",   "Wheelchair Evening Start",            "16:00",    "Wheelchair patients after this time OK (HH:MM, 24h)"],
      ["GONIO_AT_MAX_PER_DAY",       "AT/Gonio Max Per Day",                "3",        "Maximum AT or GONIO appointments allowed per day"],
      ["GONIO_EVENING_START",        "GONIO Best Evening Start",            "14:30",    "GONIO best scheduled after this time (HH:MM, 24h)"],
      ["AT_EVENING_START",           "AT Best After Start",                 "14:30",    "AT best scheduled after this time (HH:MM, 24h)"],
      ["RULE_NEW_TIMING",            "New Patient Timing Rule",             "ON",       "ON/OFF toggle"],
      ["RULE_FAMILY_TIMING",         "Family Before Cutoff Rule",           "ON",       "ON/OFF toggle"],
      ["RULE_FAMILY_MORNING",        "Family Morning Size Rule",            "ON",       "ON/OFF toggle"],
      ["RULE_NEW_CONSECUTIVE",       "Consecutive New Patient Rule",        "ON",       "ON/OFF toggle"],
      ["RULE_NEW_AFTER_4PM",         "New Patient After 4PM Rule",          "ON",       "ON/OFF toggle"],
      ["RULE_CONSULT_WINDOW",        "Consultation Window Rule",            "ON",       "ON/OFF toggle"],
      ["RULE_FAMILY_CONTINUOUS",     "Family Continuous Rule",              "ON",       "ON/OFF toggle"],
      ["RULE_GONIO_AT_CONSECUTIVE",  "AT/Gonio Consecutive Rule",           "ON",       "ON/OFF toggle"],
      ["RULE_GONIO_AT_CAP",          "AT/Gonio Daily Cap Rule",             "ON",       "ON/OFF toggle"],
      ["RULE_GONIO_TIMING",          "GONIO Best Timing Rule",              "ON",       "ON/OFF toggle"],
      ["RULE_AT_TIMING",             "AT Best Timing Rule",                 "ON",       "ON/OFF toggle"],
      ["RULE_HFA_SLOT",              "HFA Slot Rule",                       "ON",       "ON/OFF toggle"],
      ["RULE_ROP_DAY",               "ROP Day Rule",                        "ON",       "ON/OFF toggle"],
      ["RULE_LASER_DAY",             "Laser Day Rule",                      "ON",       "ON/OFF toggle"],
      ["RULE_LASER_DURATION",        "Laser Duration Rule",                 "ON",       "ON/OFF toggle"],
      ["RULE_WHEELCHAIR",            "Wheelchair Timing Rule",              "ON",       "ON/OFF toggle"]
    ];

    var rows = defaults.length;
    var values = [];
    for (var r = 0; r < rows; r++) {
      values.push([
        defaults[r][0], // ruleKey
        defaults[r][1], // ruleName
        String(defaults[r][2]), // value (always stored as string)
        defaults[r][3]  // description
      ]);
    }
    sheet.getRange(2, 1, rows, 4).setValues(values);

    // Format header row
    var headerRange = sheet.getRange(1, 1, 1, 4);
    headerRange.setFontWeight("bold");
    headerRange.setBackground("#4a90e2");
    headerRange.setFontColor("#ffffff");
    sheet.setFrozenRows(1);

    Logger.log("RuleSettings sheet created with " + rows + " default settings.");
    return true;
  } catch (e) {
    Logger.log("Error initialising RuleSettings sheet: " + e.toString());
    return false;
  }
}

/**
 * Load all rule settings from the RuleSettings sheet.
 * Returns a key-value object. Throws if required keys are missing.
 * @param {string} sessionToken
 * @return {Object} { success, settings } or { success: false, error }
 */
function loadRuleSettings(sessionToken) {
  try {
    var username = getSessionUsername(sessionToken);
    if (!username) {
      return { success: false, error: "Session expired." };
    }
    if (!hasAccessLevel(sessionToken, 1)) {
      return { success: false, error: "Admin access required to load rule settings." };
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("RuleSettings");
    if (!sheet) {
      // Sheet doesn't exist — initialise it
      initializeRuleSettingsSheet();
      sheet = ss.getSheetByName("RuleSettings");
      if (!sheet) {
        return { success: false, error: "RuleSettings sheet could not be created." };
      }
    }

    var data = sheet.getDataRange().getValues();
    var settings = {};
    for (var i = 1; i < data.length; i++) {
      var key = (data[i][0] || "").toString().trim();
      var val = normaliseRuleSettingValue_(data[i][2]);
      if (key) {
        settings[key] = val;
      }
    }

    // Validate all required keys are present
    var requiredKeys = [
      "NEW_MORNING_START", "NEW_EVENING_CUTOFF", "NEW_CONSECUTIVE_GAP",
      "FAMILY_MORNING_CUTOFF", "FAMILY_MORNING_MAX",
      "CONSULT_WINDOW_START", "CONSULT_WINDOW_LUNCH_START", "CONSULT_WINDOW_LUNCH_END", "CONSULT_WINDOW_END",
      "HFA_SLOT_1", "HFA_SLOT_2",
      "ROP_DAY", "LASER_DAYS", "LASER_DURATION",
      "WHEELCHAIR_MORNING_END", "WHEELCHAIR_EVENING_START",
      "GONIO_AT_MAX_PER_DAY", "GONIO_EVENING_START", "AT_EVENING_START",
      "RULE_NEW_TIMING", "RULE_FAMILY_TIMING", "RULE_FAMILY_MORNING",
      "RULE_NEW_CONSECUTIVE", "RULE_NEW_AFTER_4PM", "RULE_CONSULT_WINDOW",
      "RULE_FAMILY_CONTINUOUS", "RULE_GONIO_AT_CONSECUTIVE",
      "RULE_GONIO_AT_CAP", "RULE_GONIO_TIMING", "RULE_AT_TIMING",
      "RULE_HFA_SLOT", "RULE_ROP_DAY", "RULE_LASER_DAY",
      "RULE_LASER_DURATION", "RULE_WHEELCHAIR"
    ];

    var missing = [];
    for (var k = 0; k < requiredKeys.length; k++) {
      if (!(requiredKeys[k] in settings) || settings[requiredKeys[k]] === "") {
        missing.push(requiredKeys[k]);
      }
    }

    if (missing.length > 0) {
      return {
        success: false,
        error: "Missing settings in RuleSettings sheet: " + missing.join(", ") + ". Please run initializeRuleSettingsSheet() to restore defaults."
      };
    }

    // Update the cache
    ruleSettingsCache_ = settings;

    return { success: true, settings: settings };
  } catch (e) {
    Logger.log("Error loading rule settings: " + e.toString());
    return { success: false, error: e.toString() };
  }
}

/**
 * Save rule settings.
 * Admin-only (Level 1). Audit-logged.
 * @param {Object} settingsData  —   { "NEW_MORNING_START": "10:00", ... }
 * @param {string} sessionToken
 * @return {Object} { success, message/error }
 */
function saveRuleSettings(settingsData, sessionToken) {
  try {
    var username = getSessionUsername(sessionToken);
    if (!username) {
      return { success: false, error: "Session expired." };
    }
    if (!hasAccessLevel(sessionToken, 1)) {
      return { success: false, error: "Admin access required to modify rule settings." };
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("RuleSettings");
    if (!sheet) {
      initializeRuleSettingsSheet();
      sheet = ss.getSheetByName("RuleSettings");
      if (!sheet) {
        return { success: false, error: "RuleSettings sheet not found and could not be created." };
      }
    }

    var data = sheet.getDataRange().getValues();
    // Build map: key → row index (0-based in data array)
    var keyRowMap = {};
    for (var i = 1; i < data.length; i++) {
      var k = (data[i][0] || "").toString().trim();
      if (k) keyRowMap[k] = i;
    }

    var updatedCount = 0;
    var oldValues = {};
    var newValues = {};
    var keys = Object.keys(settingsData);
    for (var j = 0; j < keys.length; j++) {
      var key = keys[j];
      var val = String(settingsData[key]).trim();
      if (!(key in keyRowMap)) continue; // unknown key — skip
      var rowIdx = keyRowMap[key] + 1; // 1-based sheet row
      var old = String(data[keyRowMap[key]][2] || "").trim();
      oldValues[key] = old;
      newValues[key] = val;
      sheet.getRange(rowIdx, 3).setValue(val); // Column C = value
      updatedCount++;
    }

    // Clear cache so RuleEngine reads fresh values next time
    ruleSettingsCache_ = null;

    // Audit log
    try {
      logAuditEvent(
        sessionToken,
        "RULE_SETTINGS_CHANGE",
        "SETTINGS",
        "RULE_SETTINGS",
        {
          updatedCount: updatedCount,
          oldValues: oldValues,
          newValues: newValues,
          user: username
        }
      );
    } catch (auditErr) {
      Logger.log("Audit logging failed for rule settings: " + auditErr.toString());
    }

    return { success: true, message: updatedCount + " rule settings updated." };
  } catch (e) {
    Logger.log("Error saving rule settings: " + e.toString());
    return { success: false, error: e.toString() };
  }
}

/**
 * Get all rule settings as a key-value map (module-level cache).
 * Reads from the RuleSettings sheet on first call per execution,
 * then caches for subsequent calls.
 * Called each time validateDayRules() starts.
 * @return {Object} settings map, or empty object on failure
 */
/**
 * Normalise a cell value (Date/time to HH:MM, everything else to string).
 * Google Sheets auto-interprets "10:00" as a time and stores it as a Date object.
 * @param {*} rawValue  —  raw cell value from sheet
 * @return {string}
 */
function normaliseRuleSettingValue_(rawValue) {
  if (rawValue === null || rawValue === undefined) return "";
  if (Object.prototype.toString.call(rawValue) === "[object Date]") {
    if (isNaN(rawValue.getTime())) return "";
    var hh = rawValue.getHours();
    var mm = rawValue.getMinutes();
    return (hh < 10 ? "0" + hh : hh) + ":" + (mm < 10 ? "0" + mm : mm);
  }
  return String(rawValue).trim();
}

function getRuleSettingsMap() {
  if (ruleSettingsCache_) {
    return ruleSettingsCache_;
  }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("RuleSettings");
    if (!sheet) {
      // Sheet missing — try to initialise
      initializeRuleSettingsSheet();
      sheet = ss.getSheetByName("RuleSettings");
      if (!sheet) return {};
    }

    var data = sheet.getDataRange().getValues();
    var settings = {};
    for (var i = 1; i < data.length; i++) {
      var key = (data[i][0] || "").toString().trim();
      var val = normaliseRuleSettingValue_(data[i][2]);
      if (key) {
        settings[key] = val;
      }
    }
    ruleSettingsCache_ = settings;
    return settings;
  } catch (e) {
    Logger.log("getRuleSettingsMap failed: " + e.toString());
    return {};
  }
}

/**
 * Clear the in-memory rule settings cache
 */
function clearRuleSettingsCache() {
  ruleSettingsCache_ = null;
}
