const {
  makeWASocket,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
  delay,
  downloadMediaMessage,
  getUrlInfo,
  generateProfilePicture,
} = require("baileys");
const { useMySQLAuthState } = require("mysql-baileys");
const { toDataURL } = require("qrcode");
const pino = require("pino");
const { query } = require("../../../database/dbpromise");
const { processMessage } = require("../../inbox/inbox");

// MySQL configuration
const MYSQL_CONFIG = {
  host: process.env.DBHOST || "localhost",
  port: process.env.DBPORT || 3306,
  user: process.env.DBUSER,
  password: process.env.DBPASS,
  database: process.env.DBNAME,
  tableName: "auth",
  retryRequestDelayMs: 200,
};

// Active connections tracking
const activeConnections = new Map();

/**
 * Extract user ID from session ID
 * @param {string} input - Session ID
 * @returns {string} - User ID
 */
function extractUidFromSessionId(input) {
  return input.split("_")[0];
}

/**
 * Extract phone number from WhatsApp ID
 * @param {string} str - WhatsApp ID
 * @returns {string|null} - Phone number
 */
function extractPhoneNumber(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)(?=:|\@)/);
  return match ? match[1] : null;
}

/**
 * Check if a session exists in active connections
 * @param {string} sessionId - The session identifier
 * @returns {boolean} - Whether the session exists
 */
const isSessionExists = (sessionId) => {
  return activeConnections.has(sessionId);
};

/**
 * Create a new WhatsApp session
 * @param {string} sessionId - The session identifier
 * @param {string} title - Browser name to display
 * @param {object} options - Additional options
 * @returns {Promise<string>} - Session creation status
 */
const createSession = async (
  sessionId,
  title = "Chrome",
  options = { onQr: null, syncFullHistory: false }
) => {
  try {
    const logger = pino({ level: "silent" });
    const { error, version } = await fetchLatestBaileysVersion();

    console.log({ version });

    if (error) {
      console.log(
        `Session: ${sessionId} | No connection, check your internet.`
      );
    }

    // Configure MySQL authentication with session-specific ID
    const { state, saveCreds, removeCreds } = await useMySQLAuthState({
      ...MYSQL_CONFIG,
      session: sessionId,
    });

    // Create WhatsApp connection
    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      version,
      logger,
      printQRInTerminal: false,
      browser: [title, "", ""],
      syncFullHistory: options.syncFullHistory,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: true,
    });

    // Store active connection
    activeConnections.set(sessionId, sock);

    // Handle credential updates
    sock.ev.on("creds.update", saveCreds);

    // Handle messages update (for poll updates)
    sock.ev.on("messages.update", async (m) => {
      const message = m[0];
      if (message?.update && message?.key?.remoteJid !== "status@broadcast") {
        const uid = extractUidFromSessionId(sessionId);
        if (uid && message?.update?.status) {
          processMessage({
            body: message,
            uid: extractUidFromSessionId(sessionId),
            origin: "qr",
            getSession,
            sessionId,
            qrType: "update",
          });
        }
      }
    });

    // Handle new messages
    sock.ev.on("messages.upsert", async (m) => {
      const message = m.messages[0];
      if (
        message?.key?.remoteJid !== "status@broadcast" &&
        m.type === "notify" &&
        message?.key?.remoteJid?.endsWith("@s.whatsapp.net")
      ) {
        const uid = extractUidFromSessionId(sessionId);
        if (uid) {
          processMessage({
            body: message,
            uid: extractUidFromSessionId(sessionId),
            origin: "qr",
            getSession,
            sessionId,
            qrType: "upsert",
          });
        }
      }
    });

    // Handle connection updates
    sock.ev.on(
      "connection.update",
      async ({ connection, lastDisconnect, qr }) => {
        if (connection === "open") {
          console.log(`Session ${sessionId} connected successfully.`);

          try {
            const userData = sock.user || {};
            await query(
              "UPDATE instance SET status = ?, number = ?, data = ? WHERE uniqueId = ?",
              [
                "ACTIVE",
                extractPhoneNumber(userData?.id) || null,
                userData?.id ? JSON.stringify(userData) : null,
                sessionId,
              ]
            );
          } catch (error) {
            console.error("Database update error (open):", error);
          }
        } else if (connection === "close") {
          const statusCode = lastDisconnect?.error?.output?.statusCode;

          if (statusCode === DisconnectReason.loggedOut) {
            console.log(`Session ${sessionId} logged out.`);
            activeConnections.delete(sessionId);
            await removeCreds();

            try {
              await query("UPDATE instance SET status = ? WHERE uniqueId = ?", [
                "INACTIVE",
                sessionId,
              ]);
            } catch (error) {
              console.error("Database update error (logout):", error);
            }
          } else {
            console.log(
              `Session ${sessionId} disconnected, attempting reconnect...`
            );
            setTimeout(() => createSession(sessionId, title, options), 5000);
          }
        }

        if (qr) {
          try {
            const qrCodeImage = await toDataURL(qr);
            try {
              await query("UPDATE instance SET qr = ? WHERE uniqueId = ?", [
                qrCodeImage,
                sessionId,
              ]);
            } catch (error) {
              console.error("Database update error (qr):", error);
            }

            if (typeof options.onQr === "function") {
              options.onQr(qrCodeImage);
            }
          } catch (error) {
            console.error("QR processing error:", error);
          }
        }
      }
    );

    return "Session initiated";
  } catch (error) {
    console.error(`Error creating session ${sessionId}:`, error);
    return "Failed to create session";
  }
};

/**
 * Get an active session
 * @param {string} sessionId - Session identifier
 * @returns {object|null} - WhatsApp session or null
 */
const getSession = (sessionId) => {
  return activeConnections.get(sessionId) || null;
};

/**
 * Delete a session
 * @param {string} sessionId - Session identifier
 * @returns {Promise<void>}
 */
const deleteSession = async (sessionId) => {
  try {
    const session = getSession(sessionId);
    if (session) {
      try {
        await session.logout();
      } catch (error) {
        console.error(`Error logging out session ${sessionId}:`, error);
      }
      activeConnections.delete(sessionId);
    }

    try {
      await query("UPDATE instance SET status = ? WHERE uniqueId = ?", [
        "INACTIVE",
        sessionId,
      ]);
    } catch (error) {
      console.error("Database update error (deleteSession):", error);
    }
  } catch (error) {
    console.error(`Error deleting session ${sessionId}:`, error);
  }
};

/**
 * Check if a phone number or group exists
 * @param {object} session - WhatsApp session
 * @param {string} jid - JID to check
 * @param {boolean} isGroup - Whether JID is a group
 * @returns {Promise<boolean>} - Whether JID exists
 */
const isExists = async (session, jid, isGroup = false) => {
  try {
    let result;
    if (isGroup) {
      result = await session.groupMetadata(jid);
      return Boolean(result.id);
    }
    [result] = await session.onWhatsApp(jid);
    if (typeof result === "undefined") {
      const getNum = jid.replace("@s.whatsapp.net", "");
      [result] = await session.onWhatsApp(`+${getNum}`);
    }
    return result?.exists;
  } catch (err) {
    console.error("isExists error:", err);
    return false;
  }
};

/**
 * Send a message
 * @param {object} session - WhatsApp session
 * @param {string} receiver - Receiver JID
 * @param {object} message - Message object
 * @returns {Promise<object>} - Send result
 */
const sendMessage = async (session, receiver, message) => {
  try {
    if (message?.text) {
      try {
        const linkPreview = await getUrlInfo(message.text, {
          thumbnailWidth: 1024,
          fetchOpts: { timeout: 5000 },
          uploadImage: session.waUploadToServer,
        });

        message = {
          text: message.text,
          linkPreview,
        };
      } catch (error) {
        console.error("Error generating link preview:", error);
        // Continue with just text if link preview fails
      }
    }

    await delay(1000);
    return session.sendMessage(receiver, message);
  } catch (err) {
    console.error("sendMessage error:", err);
    return Promise.reject(null);
  }
};

/**
 * Get group metadata
 * @param {object} session - WhatsApp session
 * @param {string} jid - Group JID
 * @returns {Promise<object>} - Group metadata
 */
const getGroupData = async (session, jid) => {
  try {
    return await session.groupMetadata(jid);
  } catch (err) {
    console.error("getGroupData error:", err);
    return Promise.reject(null);
  }
};

/**
 * Format phone number to WhatsApp JID
 * @param {string} phone - Phone number
 * @returns {string} - WhatsApp JID
 */
const formatPhone = (phone) => {
  if (phone.endsWith("@s.whatsapp.net")) return phone;
  let formatted = phone.replace(/\D/g, "");
  return formatted + "@s.whatsapp.net";
};

/**
 * Format group ID to WhatsApp group JID
 * @param {string} group - Group ID
 * @returns {string} - WhatsApp group JID
 */
const formatGroup = (group) => {
  if (group.endsWith("@g.us")) return group;
  let formatted = group.replace(/[^\d-]/g, "");
  return formatted + "@g.us";
};

/**
 * Cleanup function for graceful shutdown
 */
const cleanup = () => {
  console.log("Running cleanup before exit.");
  activeConnections.forEach(async (session, sessionId) => {
    try {
      console.log(`Closing session ${sessionId}`);
      await session.end();
    } catch (error) {
      console.error(`Error closing session ${sessionId}:`, error);
    }
  });
};

/**
 * Initialize existing sessions from database
 * @returns {Promise<void>}
 */
const init = async () => {
  try {
    const instances = await query(
      "SELECT uniqueId FROM instance WHERE status = 'ACTIVE'",
      []
    );
    console.log({ instances });
    for (const instance of instances) {
      await createSession(instance.uniqueId);
    }
    console.log(`Initialized ${instances.length} active sessions`);
  } catch (error) {
    console.error("Error initializing sessions:", error);
  }
};

/**
 * Check if QR code functionality is available
 * @returns {boolean} - Whether QR functionality is available
 */
function checkQr() {
  return true;
}

module.exports = {
  isSessionExists,
  createSession,
  getSession,
  deleteSession,
  isExists,
  sendMessage,
  formatPhone,
  formatGroup,
  cleanup,
  init,
  getGroupData,
  getUrlInfo,
  downloadMediaMessage,
  checkQr,
  generateProfilePicture,
};
