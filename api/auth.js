import { db } from "../utils/firebase.js";
import crypto from 'crypto';

// ============================================
// Configuration
// ============================================
const USERS_PATH = 'Users';
const SESSIONS_PATH = 'Sessions';
const DEVICES_PATH = 'Devices';
const IP_ACCOUNT_LIMIT = 3; // Max accounts per IP
const DEVICE_ACCOUNT_LIMIT = 1; // Max accounts per device
const SESSION_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';

// ============================================
// Helper Functions
// ============================================

// Hash password using crypto (no bcrypt dependency)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .pbkdf2Sync(password, salt, 10000, 64, 'sha512')
    .toString('hex');
  return `${salt}:${hash}`;
}

// Verify password
function verifyPassword(password, storedHash) {
  const [salt, hash] = storedHash.split(':');
  const verifyHash = crypto
    .pbkdf2Sync(password, salt, 10000, 64, 'sha512')
    .toString('hex');
  return hash === verifyHash;
}

// Generate JWT-like token (simple secure token)
function generateToken(userId, sessionId) {
  const payload = `${userId}|${sessionId}|${Date.now()}`;
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(payload)
    .digest('hex');
  return Buffer.from(`${payload}|${signature}`).toString('base64');
}

// Verify token
function verifyToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64').toString();
    const [userId, sessionId, timestamp, signature] = decoded.split('|');
    
    const verifyPayload = `${userId}|${sessionId}|${timestamp}`;
    const verifySignature = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(verifyPayload)
      .digest('hex');
    
    if (signature !== verifySignature) return null;
    
    // Check expiry (7 days)
    if (Date.now() - parseInt(timestamp) > SESSION_EXPIRY) return null;
    
    return { userId, sessionId };
  } catch {
    return null;
  }
}

// Generate device fingerprint
function generateDeviceFingerprint(deviceId) {
  return crypto
    .createHash('sha256')
    .update(deviceId || 'unknown')
    .digest('hex');
}

// Generate session ID
function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

// Validation functions
function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

function validatePassword(password) {
  // Min 8 chars, at least one letter, one number, one special character
  const re = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*#?&])[A-Za-z\d@$!%*#?&]{8,}$/;
  return re.test(password);
}

function validateUsername(username) {
  // Alphanumeric, underscore, 3-20 chars
  const re = /^[a-zA-Z0-9_]{3,20}$/;
  return re.test(username);
}

// Get client IP
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || 
         req.socket?.remoteAddress || 
         req.connection?.remoteAddress ||
         'unknown';
}

// Safe body parser helper
function getBody(req) {
  return req.body || {};
}

// Rate limiting helper
async function checkRateLimit(ip, action) {
  const rateLimitRef = db.ref(`RateLimits/${action}/${ip.replace(/\./g, '_')}`);
  const snapshot = await rateLimitRef.once('value');
  const now = Date.now();
  
  if (snapshot.exists()) {
    const data = snapshot.val();
    const timeWindow = 60 * 60 * 1000; // 1 hour
    const maxAttempts = action === 'register' ? 5 : 10;
    
    // Clean old attempts
    const attempts = (data.attempts || []).filter(t => now - t < timeWindow);
    
    if (attempts.length >= maxAttempts) {
      return false;
    }
    
    attempts.push(now);
    await rateLimitRef.update({ attempts });
    return true;
  } else {
    await rateLimitRef.set({ attempts: [now] });
    return true;
  }
}

// ============================================
// Main API Handler
// ============================================

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ✅ FIXED: Safe extraction with optional chaining
  const body = getBody(req);
  const action = req.query.action || body.action || null;
  const clientIP = getClientIP(req);
  const deviceId = body.device_id || req.query.device_id || req.headers['x-device-id'];

  // ✅ FIXED: Validate action exists for methods that need it
  if (!action && ['POST', 'PUT', 'DELETE'].includes(req.method)) {
    return res.status(400).json({
      success: false,
      error: 'Missing action parameter',
      message: 'Please provide an action in the query string or request body',
      hint: 'Example: ?action=register or { "action": "login" }'
    });
  }

  // ============================================
  // PUBLIC: Health Check
  // ============================================
  if (req.method === 'GET' && !action) {
    return res.status(200).json({
      success: true,
      message: 'Auth API is running',
      timestamp: Date.now()
    });
  }

  try {
    // ============================================
    // REGISTER - POST /api/auth?action=register
    // ============================================
    if (req.method === 'POST' && action === 'register') {
      const { email, password, username } = body;

      // Validate input
      if (!email || !password || !username) {
        return res.status(400).json({ 
          success: false,
          error: 'Email, password, and username are required' 
        });
      }

      if (!validateEmail(email)) {
        return res.status(400).json({ 
          success: false,
          error: 'Invalid email format' 
        });
      }

      if (!validatePassword(password)) {
        return res.status(400).json({ 
          success: false,
          error: 'Password must be at least 8 characters with letters, numbers, and special characters' 
        });
      }

      if (!validateUsername(username)) {
        return res.status(400).json({ 
          success: false,
          error: 'Username must be 3-20 characters (letters, numbers, underscore only)' 
        });
      }

      // Check rate limit
      const rateLimitOK = await checkRateLimit(clientIP, 'register');
      if (!rateLimitOK) {
        return res.status(429).json({ 
          success: false,
          error: 'Too many registration attempts. Please try again later.' 
        });
      }

      // Check if email already exists
      const usersRef = db.ref(USERS_PATH);
      const emailSnapshot = await usersRef.orderByChild('email').equalTo(email.toLowerCase()).once('value');
      
      let emailExists = false;
      emailSnapshot.forEach(() => { emailExists = true; });
      
      if (emailExists) {
        return res.status(409).json({ 
          success: false,
          error: 'Email already registered' 
        });
      }

      // Check if username already exists
      const usernameSnapshot = await usersRef.orderByChild('username').equalTo(username).once('value');
      
      let usernameExists = false;
      usernameSnapshot.forEach(() => { usernameExists = true; });
      
      if (usernameExists) {
        return res.status(409).json({ 
          success: false,
          error: 'Username already taken' 
        });
      }

      // Check device limit (one account per device)
      const deviceHash = generateDeviceFingerprint(deviceId);
      const deviceRef = db.ref(`${DEVICES_PATH}/${deviceHash}`);
      const deviceSnapshot = await deviceRef.once('value');
      
      if (deviceSnapshot.exists()) {
        const deviceData = deviceSnapshot.val();
        if (deviceData.user_ids && deviceData.user_ids.length >= DEVICE_ACCOUNT_LIMIT) {
          return res.status(403).json({ 
            success: false,
            error: 'This device already has an account. One account per device allowed.' 
          });
        }
      }

      // Check IP limit
      const ipRef = db.ref(`${DEVICES_PATH}/by_ip/${clientIP.replace(/\./g, '_')}`);
      const ipSnapshot = await ipRef.once('value');
      
      if (ipSnapshot.exists()) {
        const ipData = ipSnapshot.val();
        if (ipData.user_ids && ipData.user_ids.length >= IP_ACCOUNT_LIMIT) {
          return res.status(403).json({ 
            success: false,
            error: `Too many accounts from this IP address (max ${IP_ACCOUNT_LIMIT})` 
          });
        }
      }

      // Create user
      const userId = username; // Use username as the ID
      const hashedPassword = hashPassword(password);
      const now = Date.now();

      const userData = {
        id: userId,
        username: username,
        email: email.toLowerCase(),
        password: hashedPassword,
        created_at: now,
        updated_at: now,
        last_login: null,
        email_verified: false,
        is_active: true,
        profile: {
          displayName: username,
          bio: '',
          avatar: null
        },
        metadata: {
          ip: clientIP,
          device_id: deviceId || 'unknown',
          device_hash: deviceHash,
          created_with: 'web'
        }
      };

      // Save user
      const userRef = db.ref(`${USERS_PATH}/${userId}`);
      await userRef.set(userData);

      // Register device
      const deviceData = {
        device_hash: deviceHash,
        device_id: deviceId || 'unknown',
        user_ids: [userId],
        first_seen: now,
        last_seen: now,
        ip_addresses: [clientIP]
      };
      await deviceRef.set(deviceData);

      // Register IP
      const ipData = {
        user_ids: [userId],
        first_seen: now,
        last_seen: now
      };
      await ipRef.set(ipData);

      // Create session
      const sessionId = generateSessionId();
      const sessionData = {
        user_id: userId,
        session_id: sessionId,
        created_at: now,
        expires_at: now + SESSION_EXPIRY,
        device_hash: deviceHash,
        ip_address: clientIP,
        user_agent: req.headers['user-agent'] || 'unknown'
      };
      const sessionRef = db.ref(`${SESSIONS_PATH}/${sessionId}`);
      await sessionRef.set(sessionData);

      // Generate token
      const token = generateToken(userId, sessionId);

      // Remove password from response
      const { password: _, ...userWithoutPassword } = userData;

      return res.status(201).json({
        success: true,
        message: 'Account created successfully',
        user: userWithoutPassword,
        token: token,
        session_id: sessionId
      });
    }

    // ============================================
    // LOGIN - POST /api/auth?action=login
    // ============================================
    if (req.method === 'POST' && action === 'login') {
      const { email, password } = body;

      if (!email || !password) {
        return res.status(400).json({ 
          success: false,
          error: 'Email and password are required' 
        });
      }

      // Check rate limit
      const rateLimitOK = await checkRateLimit(clientIP, 'login');
      if (!rateLimitOK) {
        return res.status(429).json({ 
          success: false,
          error: 'Too many login attempts. Please try again later.' 
        });
      }

      // Find user by email
      const usersRef = db.ref(USERS_PATH);
      const snapshot = await usersRef.orderByChild('email').equalTo(email.toLowerCase()).once('value');
      
      if (!snapshot.exists()) {
        return res.status(401).json({ 
          success: false,
          error: 'Invalid credentials' 
        });
      }

      let userData = null;
      let userId = null;
      snapshot.forEach((childSnapshot) => {
        userData = childSnapshot.val();
        userId = childSnapshot.key;
      });

      if (!userData.is_active) {
        return res.status(403).json({ 
          success: false,
          error: 'Account is disabled' 
        });
      }

      // Verify password
      if (!verifyPassword(password, userData.password)) {
        return res.status(401).json({ 
          success: false,
          error: 'Invalid credentials' 
        });
      }

      const now = Date.now();
      const deviceHash = generateDeviceFingerprint(deviceId);

      // Check/Update device
      const deviceRef = db.ref(`${DEVICES_PATH}/${deviceHash}`);
      const deviceSnapshot = await deviceRef.once('value');
      
      if (deviceSnapshot.exists()) {
        const deviceData = deviceSnapshot.val();
        if (!deviceData.user_ids.includes(userId)) {
          if (deviceData.user_ids.length >= DEVICE_ACCOUNT_LIMIT) {
            return res.status(403).json({ 
              success: false,
              error: 'This device has reached the maximum number of accounts' 
            });
          }
          // Add this user to device
          deviceData.user_ids.push(userId);
          await deviceRef.update({
            user_ids: deviceData.user_ids,
            last_seen: now
          });
        }
      } else {
        // Register new device
        await deviceRef.set({
          device_hash: deviceHash,
          device_id: deviceId || 'unknown',
          user_ids: [userId],
          first_seen: now,
          last_seen: now,
          ip_addresses: [clientIP]
        });
      }

      // Update IP tracking
      const ipRef = db.ref(`${DEVICES_PATH}/by_ip/${clientIP.replace(/\./g, '_')}`);
      const ipSnapshot = await ipRef.once('value');
      
      if (ipSnapshot.exists()) {
        const ipData = ipSnapshot.val();
        if (!ipData.user_ids.includes(userId)) {
          ipData.user_ids.push(userId);
          await ipRef.update({
            user_ids: ipData.user_ids,
            last_seen: now
          });
        }
      } else {
        await ipRef.set({
          user_ids: [userId],
          first_seen: now,
          last_seen: now
        });
      }

      // Create session
      const sessionId = generateSessionId();
      const sessionData = {
        user_id: userId,
        session_id: sessionId,
        created_at: now,
        expires_at: now + SESSION_EXPIRY,
        device_hash: deviceHash,
        ip_address: clientIP,
        user_agent: req.headers['user-agent'] || 'unknown'
      };
      const sessionRef = db.ref(`${SESSIONS_PATH}/${sessionId}`);
      await sessionRef.set(sessionData);

      // Update last login
      const userRef = db.ref(`${USERS_PATH}/${userId}`);
      await userRef.update({
        last_login: now,
        updated_at: now
      });

      // Generate token
      const token = generateToken(userId, sessionId);

      // Remove password from response
      const { password: _, ...userWithoutPassword } = userData;

      return res.status(200).json({
        success: true,
        message: 'Login successful',
        user: userWithoutPassword,
        token: token,
        session_id: sessionId
      });
    }

    // ============================================
    // VERIFY - GET /api/auth?action=verify
    // ============================================
    if ((req.method === 'GET' || req.method === 'POST') && action === 'verify') {
      const token = req.headers.authorization?.replace('Bearer ', '') || 
                    req.query.token || 
                    body.token;

      if (!token) {
        return res.status(401).json({ 
          success: false,
          error: 'Token required' 
        });
      }

      const decoded = verifyToken(token);
      if (!decoded) {
        return res.status(401).json({ 
          success: false,
          error: 'Invalid or expired token' 
        });
      }

      const { userId, sessionId } = decoded;

      // Check session exists
      const sessionRef = db.ref(`${SESSIONS_PATH}/${sessionId}`);
      const sessionSnapshot = await sessionRef.once('value');
      
      if (!sessionSnapshot.exists()) {
        return res.status(401).json({ 
          success: false,
          error: 'Session expired' 
        });
      }

      const sessionData = sessionSnapshot.val();
      if (sessionData.user_id !== userId) {
        return res.status(401).json({ 
          success: false,
          error: 'Invalid session' 
        });
      }

      // Check session expiry
      if (sessionData.expires_at < Date.now()) {
        await sessionRef.remove();
        return res.status(401).json({ 
          success: false,
          error: 'Session expired' 
        });
      }

      // Get user data
      const userRef = db.ref(`${USERS_PATH}/${userId}`);
      const userSnapshot = await userRef.once('value');
      
      if (!userSnapshot.exists()) {
        return res.status(401).json({ 
          success: false,
          error: 'User not found' 
        });
      }

      const userData = userSnapshot.val();
      const { password: _, ...userWithoutPassword } = userData;

      return res.status(200).json({
        success: true,
        user: userWithoutPassword,
        session_id: sessionId
      });
    }

    // ============================================
    // LOGOUT - POST /api/auth?action=logout
    // ============================================
    if (req.method === 'POST' && action === 'logout') {
      const token = req.headers.authorization?.replace('Bearer ', '') || body.token;

      if (!token) {
        return res.status(401).json({ 
          success: false,
          error: 'Token required' 
        });
      }

      const decoded = verifyToken(token);
      if (!decoded) {
        return res.status(401).json({ 
          success: false,
          error: 'Invalid token' 
        });
      }

      const { sessionId } = decoded;

      // Delete session
      const sessionRef = db.ref(`${SESSIONS_PATH}/${sessionId}`);
      await sessionRef.remove();

      return res.status(200).json({
        success: true,
        message: 'Logged out successfully'
      });
    }

    // ============================================
    // CHANGE PASSWORD - PUT /api/auth?action=change-password
    // ============================================
    if (req.method === 'PUT' && action === 'change-password') {
      const token = req.headers.authorization?.replace('Bearer ', '') || body.token;
      const { current_password, new_password } = body;

      if (!token) {
        return res.status(401).json({ 
          success: false,
          error: 'Token required' 
        });
      }

      if (!current_password || !new_password) {
        return res.status(400).json({ 
          success: false,
          error: 'Current password and new password are required' 
        });
      }

      if (!validatePassword(new_password)) {
        return res.status(400).json({ 
          success: false,
          error: 'Password must be at least 8 characters with letters, numbers, and special characters' 
        });
      }

      const decoded = verifyToken(token);
      if (!decoded) {
        return res.status(401).json({ 
          success: false,
          error: 'Invalid or expired token' 
        });
      }

      const { userId } = decoded;

      // Get user
      const userRef = db.ref(`${USERS_PATH}/${userId}`);
      const userSnapshot = await userRef.once('value');
      
      if (!userSnapshot.exists()) {
        return res.status(404).json({ 
          success: false,
          error: 'User not found' 
        });
      }

      const userData = userSnapshot.val();

      // Verify current password
      if (!verifyPassword(current_password, userData.password)) {
        return res.status(401).json({ 
          success: false,
          error: 'Current password is incorrect' 
        });
      }

      // Update password
      const hashedPassword = hashPassword(new_password);
      await userRef.update({
        password: hashedPassword,
        updated_at: Date.now()
      });

      return res.status(200).json({
        success: true,
        message: 'Password changed successfully'
      });
    }

    // ============================================
    // GET PROFILE - GET /api/auth?action=profile
    // ============================================
    if (req.method === 'GET' && action === 'profile') {
      const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;

      if (!token) {
        return res.status(401).json({ 
          success: false,
          error: 'Token required' 
        });
      }

      const decoded = verifyToken(token);
      if (!decoded) {
        return res.status(401).json({ 
          success: false,
          error: 'Invalid or expired token' 
        });
      }

      const { userId } = decoded;

      // Get user
      const userRef = db.ref(`${USERS_PATH}/${userId}`);
      const userSnapshot = await userRef.once('value');
      
      if (!userSnapshot.exists()) {
        return res.status(404).json({ 
          success: false,
          error: 'User not found' 
        });
      }

      const userData = userSnapshot.val();
      const { password: _, ...userWithoutPassword } = userData;

      return res.status(200).json({
        success: true,
        user: userWithoutPassword
      });
    }

    // ============================================
    // UPDATE PROFILE - PUT /api/auth?action=profile
    // ============================================
    if (req.method === 'PUT' && action === 'profile') {
      const token = req.headers.authorization?.replace('Bearer ', '') || body.token;
      const { displayName, bio, avatar } = body;

      if (!token) {
        return res.status(401).json({ 
          success: false,
          error: 'Token required' 
        });
      }

      const decoded = verifyToken(token);
      if (!decoded) {
        return res.status(401).json({ 
          success: false,
          error: 'Invalid or expired token' 
        });
      }

      const { userId } = decoded;

      // Get user
      const userRef = db.ref(`${USERS_PATH}/${userId}`);
      const userSnapshot = await userRef.once('value');
      
      if (!userSnapshot.exists()) {
        return res.status(404).json({ 
          success: false,
          error: 'User not found' 
        });
      }

      // Update profile
      const updates = {
        updated_at: Date.now()
      };

      if (displayName) {
        updates['profile/displayName'] = displayName;
      }
      if (bio !== undefined) {
        updates['profile/bio'] = bio;
      }
      if (avatar !== undefined) {
        updates['profile/avatar'] = avatar;
      }

      await userRef.update(updates);

      // Get updated user data
      const updatedSnapshot = await userRef.once('value');
      const userData = updatedSnapshot.val();
      const { password: _, ...userWithoutPassword } = userData;

      return res.status(200).json({
        success: true,
        message: 'Profile updated successfully',
        user: userWithoutPassword
      });
    }

    // ============================================
    // DELETE ACCOUNT - DELETE /api/auth?action=delete
    // ============================================
    if (req.method === 'DELETE' && action === 'delete') {
      const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;

      if (!token) {
        return res.status(401).json({ 
          success: false,
          error: 'Token required' 
        });
      }

      const decoded = verifyToken(token);
      if (!decoded) {
        return res.status(401).json({ 
          success: false,
          error: 'Invalid or expired token' 
        });
      }

      const { userId, sessionId } = decoded;

      // Get user data
      const userRef = db.ref(`${USERS_PATH}/${userId}`);
      const userSnapshot = await userRef.once('value');
      
      if (!userSnapshot.exists()) {
        return res.status(404).json({ 
          success: false,
          error: 'User not found' 
        });
      }

      const userData = userSnapshot.val();

      // Delete user
      await userRef.remove();

      // Delete session
      await db.ref(`${SESSIONS_PATH}/${sessionId}`).remove();

      // Remove from device
      const deviceHash = generateDeviceFingerprint(userData.metadata?.device_id);
      const deviceRef = db.ref(`${DEVICES_PATH}/${deviceHash}`);
      const deviceSnapshot = await deviceRef.once('value');
      
      if (deviceSnapshot.exists()) {
        const deviceData = deviceSnapshot.val();
        deviceData.user_ids = (deviceData.user_ids || []).filter(id => id !== userId);
        if (deviceData.user_ids.length === 0) {
          await deviceRef.remove();
        } else {
          await deviceRef.update({ user_ids: deviceData.user_ids });
        }
      }

      // Remove from IP
      const ipRef = db.ref(`${DEVICES_PATH}/by_ip/${(userData.metadata?.ip || 'unknown').replace(/\./g, '_')}`);
      const ipSnapshot = await ipRef.once('value');
      
      if (ipSnapshot.exists()) {
        const ipData = ipSnapshot.val();
        ipData.user_ids = (ipData.user_ids || []).filter(id => id !== userId);
        if (ipData.user_ids.length === 0) {
          await ipRef.remove();
        } else {
          await ipRef.update({ user_ids: ipData.user_ids });
        }
      }

      return res.status(200).json({
        success: true,
        message: 'Account deleted successfully'
      });
    }

    // ============================================
    // CHECK USERNAME - GET /api/auth?action=check-username&username=xxx
    // ============================================
    if (req.method === 'GET' && action === 'check-username') {
      const { username } = req.query;

      if (!username) {
        return res.status(400).json({ 
          success: false,
          error: 'Username required' 
        });
      }

      if (!validateUsername(username)) {
        return res.status(400).json({ 
          success: false,
          error: 'Username must be 3-20 characters (letters, numbers, underscore only)' 
        });
      }

      const usersRef = db.ref(USERS_PATH);
      const snapshot = await usersRef.orderByChild('username').equalTo(username).once('value');
      
      let exists = false;
      snapshot.forEach(() => { exists = true; });
      
      return res.status(200).json({
        success: true,
        available: !exists,
        username: username
      });
    }

    // ============================================
    // CHECK EMAIL - GET /api/auth?action=check-email&email=xxx
    // ============================================
    if (req.method === 'GET' && action === 'check-email') {
      const { email } = req.query;

      if (!email) {
        return res.status(400).json({ 
          success: false,
          error: 'Email required' 
        });
      }

      if (!validateEmail(email)) {
        return res.status(400).json({ 
          success: false,
          error: 'Invalid email format' 
        });
      }

      const usersRef = db.ref(USERS_PATH);
      const snapshot = await usersRef.orderByChild('email').equalTo(email.toLowerCase()).once('value');
      
      let exists = false;
      snapshot.forEach(() => { exists = true; });
      
      return res.status(200).json({
        success: true,
        available: !exists,
        email: email
      });
    }

    // ============================================
    // GET DEVICES - GET /api/auth?action=devices
    // ============================================
    if (req.method === 'GET' && action === 'devices') {
      const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;

      if (!token) {
        return res.status(401).json({ 
          success: false,
          error: 'Token required' 
        });
      }

      const decoded = verifyToken(token);
      if (!decoded) {
        return res.status(401).json({ 
          success: false,
          error: 'Invalid or expired token' 
        });
      }

      const { userId, sessionId } = decoded;

      // Get all sessions for user
      const sessionsRef = db.ref(SESSIONS_PATH);
      const snapshot = await sessionsRef.orderByChild('user_id').equalTo(userId).once('value');
      
      const sessions = [];
      if (snapshot.exists()) {
        snapshot.forEach((childSnapshot) => {
          const sessionData = childSnapshot.val();
          sessions.push({
            session_id: sessionData.session_id,
            created_at: sessionData.created_at,
            expires_at: sessionData.expires_at,
            device_hash: sessionData.device_hash,
            ip_address: sessionData.ip_address,
            user_agent: sessionData.user_agent,
            is_current: sessionData.session_id === sessionId
          });
        });
      }

      return res.status(200).json({
        success: true,
        sessions: sessions,
        current_session: sessionId
      });
    }

    // ============================================
    // REVOKE SESSION - DELETE /api/auth?action=revoke-session&session_id=xxx
    // ============================================
    if (req.method === 'DELETE' && action === 'revoke-session') {
      const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
      const { session_id } = req.query;

      if (!token || !session_id) {
        return res.status(400).json({ 
          success: false,
          error: 'Token and session_id are required' 
        });
      }

      const decoded = verifyToken(token);
      if (!decoded) {
        return res.status(401).json({ 
          success: false,
          error: 'Invalid or expired token' 
        });
      }

      const { userId } = decoded;

      // Verify session belongs to user
      const sessionRef = db.ref(`${SESSIONS_PATH}/${session_id}`);
      const sessionSnapshot = await sessionRef.once('value');
      
      if (!sessionSnapshot.exists()) {
        return res.status(404).json({ 
          success: false,
          error: 'Session not found' 
        });
      }

      const sessionData = sessionSnapshot.val();
      if (sessionData.user_id !== userId) {
        return res.status(403).json({ 
          success: false,
          error: 'Unauthorized' 
        });
      }

      // Can't revoke current session
      if (session_id === decoded.sessionId) {
        return res.status(400).json({ 
          success: false,
          error: 'Cannot revoke current session. Use logout instead.' 
        });
      }

      await sessionRef.remove();

      return res.status(200).json({
        success: true,
        message: 'Session revoked successfully'
      });
    }

    // ============================================
    // 404 - Action not found
    // ============================================
    return res.status(404).json({ 
      success: false,
      error: 'Action not found',
      available_actions: [
        'register', 'login', 'verify', 'logout', 
        'profile', 'change-password', 'delete',
        'check-username', 'check-email', 
        'devices', 'revoke-session'
      ]
    });

  } catch (error) {
    console.error('Auth API Error:', error);
    return res.status(500).json({ 
      success: false,
      error: 'Internal server error',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}