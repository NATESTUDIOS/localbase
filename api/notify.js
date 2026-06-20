import { db } from "../utils/firebase.js";
import crypto from 'crypto';

// ============================================
// Configuration
// ============================================
const NOTIFICATION_HISTORY_LIMIT = 20;
const DEFAULT_TOPIC = "general";
const USERS_PATH = 'Users';
const NOTIFICATIONS_PATH = 'Notifications';
const NOTIFICATION_HISTORY_PATH = 'NotificationHistory';

// ============================================
// Helper Functions
// ============================================

function generateNotificationId() {
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  return `notif_${timestamp}_${random}`;
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || 
         req.socket?.remoteAddress || 
         req.connection?.remoteAddress ||
         'unknown';
}

function getUserAgent(req) {
  return req.headers['user-agent'] || 'unknown';
}

// Validate notification data
function validateNotificationData(title, body) {
  if (!title || !title.trim()) {
    return { valid: false, error: "Title is required" };
  }
  if (!body || !body.trim()) {
    return { valid: false, error: "Body is required" };
  }
  if (title.length > 100) {
    return { valid: false, error: "Title too long (max 100 characters)" };
  }
  if (body.length > 500) {
    return { valid: false, error: "Body too long (max 500 characters)" };
  }
  return { valid: true };
}

// Validate topic name
function validateTopic(topic) {
  return /^[a-zA-Z0-9-_.~%]+$/.test(topic);
}

// Store notification for user
async function storeNotificationForUser(user_id, notificationData) {
  try {
    const notificationId = generateNotificationId();
    const timestamp = Date.now();

    const notificationRecord = {
      id: notificationId,
      title: notificationData.title || '',
      body: notificationData.body || '',
      timestamp: timestamp,
      topic: notificationData.topic || 'direct',
      imageUrl: notificationData.imageUrl || null,
      link: notificationData.link || null,
      extra: notificationData.extra || null,
      message_id: notificationData.message_id || null,
      delivery_type: notificationData.delivery_type || 'topic',
      read: false,
      delivered_at: timestamp
    };

    await db.ref(`${NOTIFICATION_HISTORY_PATH}/${user_id}/${notificationId}`).set(notificationRecord);
    await enforceNotificationLimit(user_id);
    return notificationId;
  } catch (error) {
    console.error('Error storing notification:', error);
    return null;
  }
}

// Enforce notification history limit
async function enforceNotificationLimit(user_id) {
  try {
    const notificationsRef = db.ref(`${NOTIFICATION_HISTORY_PATH}/${user_id}`);
    const snapshot = await notificationsRef.once('value');
    if (!snapshot.exists()) return;

    const notifications = [];
    snapshot.forEach((child) => {
      notifications.push({
        key: child.key,
        timestamp: child.val().timestamp || 0
      });
    });

    notifications.sort((a, b) => a.timestamp - b.timestamp);

    if (notifications.length > NOTIFICATION_HISTORY_LIMIT) {
      const toDelete = notifications.slice(0, notifications.length - NOTIFICATION_HISTORY_LIMIT);
      const deletePromises = toDelete.map(notif =>
        db.ref(`${NOTIFICATION_HISTORY_PATH}/${user_id}/${notif.key}`).remove()
      );
      await Promise.all(deletePromises);
    }
  } catch (error) {
    console.error('Error enforcing notification limit:', error);
  }
}

// Store notifications for multiple users
async function storeNotificationForUsers(userIds, notificationData) {
  try {
    const storePromises = userIds.map(userId => 
      storeNotificationForUser(userId, notificationData)
    );
    const results = await Promise.allSettled(storePromises);
    const successCount = results.filter(r => r.status === 'fulfilled').length;
    console.log(`[Notification History] Stored for ${successCount}/${userIds.length} users`);
    return successCount;
  } catch (error) {
    console.error('Error storing notifications for multiple users:', error);
    return 0;
  }
}

// Get users subscribed to a topic
async function getUsersByTopic(topic) {
  try {
    const snapshot = await db.ref(NOTIFICATIONS_PATH).once('value');
    if (!snapshot.exists()) return [];

    const userIds = [];
    snapshot.forEach((child) => {
      const userData = child.val();
      if (userData.topics && Array.isArray(userData.topics) && 
          userData.topics.includes(topic) && userData.token) {
        userIds.push(child.key);
      }
    });
    return userIds;
  } catch (error) {
    console.error('Error getting users by topic:', error);
    return [];
  }
}

// Get user token
async function getUserToken(user_id) {
  try {
    const snapshot = await db.ref(`${NOTIFICATIONS_PATH}/${user_id}/token`).once('value');
    return snapshot.exists() ? snapshot.val() : null;
  } catch (error) {
    console.error('Error getting user token:', error);
    return null;
  }
}

// ============================================
// Main API Handler
// ============================================

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const action = req.query.action || req.body.action;
  const clientIP = getClientIP(req);
  const userAgent = getUserAgent(req);

  // ============================================
  // Health Check
  // ============================================
  if (req.method === 'GET' && !action) {
    return res.status(200).json({
      success: true,
      message: 'Notifications API is running',
      timestamp: Date.now(),
      default_topic: DEFAULT_TOPIC,
      history_limit: NOTIFICATION_HISTORY_LIMIT,
      endpoints: [
        'POST ?action=send-topic',
        'POST ?action=send-user',
        'POST ?action=send-all',
        'POST ?action=subscribe',
        'POST ?action=unsubscribe',
        'GET ?action=history&user_id=xxx',
        'GET ?action=notification&user_id=xxx&notification_id=xxx',
        'DELETE ?action=history&user_id=xxx',
        'DELETE ?action=notification&user_id=xxx&notification_id=xxx',
        'GET ?action=count&user_id=xxx',
        'GET ?action=user&user_id=xxx',
        'POST ?action=migrate',
        'GET ?action=topics&user_id=xxx'
      ]
    });
  }

  try {
    // ============================================
    // SEND TO TOPIC - POST ?action=send-topic
    // ============================================
    if (req.method === 'POST' && action === 'send-topic') {
      const { title, body, topic = DEFAULT_TOPIC, imageUrl, link, extra } = req.body;

      const validation = validateNotificationData(title, body);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }

      if (!validateTopic(topic)) {
        return res.status(400).json({ error: 'Invalid topic name' });
      }

      // Get users subscribed to this topic
      const userIds = await getUsersByTopic(topic);
      
      // Store notifications in history
      let storedCount = 0;
      if (userIds.length > 0) {
        storedCount = await storeNotificationForUsers(userIds, {
          title: title.trim(),
          body: body.trim(),
          topic,
          imageUrl,
          link,
          extra,
          message_id: `topic_${Date.now()}`,
          delivery_type: 'topic'
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Notification sent to topic',
        topic: topic,
        users_notified: userIds.length,
        history_stored: storedCount,
        timestamp: Date.now()
      });
    }

    // ============================================
    // SEND TO USER - POST ?action=send-user
    // ============================================
    if (req.method === 'POST' && action === 'send-user') {
      const { user_id, title, body, imageUrl, link, extra } = req.body;

      if (!user_id) {
        return res.status(400).json({ error: 'user_id is required' });
      }

      const validation = validateNotificationData(title, body);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }

      // Check if user has a token
      const token = await getUserToken(user_id);
      if (!token) {
        return res.status(404).json({ 
          error: 'User not found or has no device token' 
        });
      }

      // Store notification in history
      const notificationId = await storeNotificationForUser(user_id, {
        title: title.trim(),
        body: body.trim(),
        topic: 'direct',
        imageUrl,
        link,
        extra,
        message_id: `user_${Date.now()}`,
        delivery_type: 'direct'
      });

      return res.status(200).json({
        success: true,
        message: 'Notification sent to user',
        user_id,
        notification_id: notificationId,
        timestamp: Date.now()
      });
    }

    // ============================================
    // SEND TO ALL - POST ?action=send-all
    // ============================================
    if (req.method === 'POST' && action === 'send-all') {
      const { title, body, imageUrl, link, extra } = req.body;

      const validation = validateNotificationData(title, body);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }

      // Get all users with tokens
      const userIds = await getUsersByTopic(DEFAULT_TOPIC);
      
      // Store notifications for all users
      let storedCount = 0;
      if (userIds.length > 0) {
        storedCount = await storeNotificationForUsers(userIds, {
          title: title.trim(),
          body: body.trim(),
          topic: DEFAULT_TOPIC,
          imageUrl,
          link,
          extra,
          message_id: `broadcast_${Date.now()}`,
          delivery_type: 'broadcast'
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Broadcast notification sent to all users',
        topic: DEFAULT_TOPIC,
        users_notified: userIds.length,
        history_stored: storedCount,
        timestamp: Date.now()
      });
    }

    // ============================================
    // SUBSCRIBE - POST ?action=subscribe
    // ============================================
    if (req.method === 'POST' && action === 'subscribe') {
      const { user_id, token, topic, topics } = req.body;

      if (!user_id || !token) {
        return res.status(400).json({ 
          error: 'user_id and token are required' 
        });
      }

      // Normalize topics
      let finalTopics = Array.isArray(topics) && topics.length > 0
        ? topics
        : typeof topic === 'string' && topic.trim()
        ? [topic.trim()]
        : [DEFAULT_TOPIC];

      finalTopics = [...new Set(finalTopics.map(t => t.trim()).filter(t => t.length > 0))];

      // Ensure default topic is included
      if (!finalTopics.includes(DEFAULT_TOPIC)) {
        finalTopics.push(DEFAULT_TOPIC);
      }

      // Validate topics
      const invalidTopics = finalTopics.filter(t => !validateTopic(t));
      if (invalidTopics.length > 0) {
        return res.status(400).json({
          error: 'Invalid topic names',
          invalid_topics: invalidTopics
        });
      }

      // Get existing user data
      const existingSnap = await db.ref(`${NOTIFICATIONS_PATH}/${user_id}`).once('value');
      const existingData = existingSnap.val();

      // Store token and topics
      await db.ref(`${NOTIFICATIONS_PATH}/${user_id}`).set({
        token: token.trim(),
        topics: finalTopics,
        lastUpdated: Date.now(),
        ip: clientIP,
        user_agent: userAgent
      });

      // Also update user's type if they have one
      try {
        const userSnapshot = await db.ref(`${USERS_PATH}/${user_id}`).once('value');
        if (userSnapshot.exists()) {
          const userData = userSnapshot.val();
          if (userData.type && !finalTopics.includes(userData.type) && userData.type !== 'general') {
            const updatedTopics = [...finalTopics, userData.type];
            await db.ref(`${NOTIFICATIONS_PATH}/${user_id}/topics`).set(updatedTopics);
            finalTopics = updatedTopics;
          }
        }
      } catch (syncError) {
        console.warn('Failed to sync user type:', syncError.message);
      }

      return res.status(200).json({
        success: true,
        message: 'Successfully subscribed',
        user_id,
        subscribed_to: finalTopics,
        count: finalTopics.length,
        timestamp: Date.now()
      });
    }

    // ============================================
    // UNSUBSCRIBE - POST ?action=unsubscribe
    // ============================================
    if (req.method === 'POST' && action === 'unsubscribe') {
      const { user_id, topics } = req.body;

      if (!user_id) {
        return res.status(400).json({ error: 'user_id is required' });
      }

      const snap = await db.ref(`${NOTIFICATIONS_PATH}/${user_id}`).once('value');
      if (!snap.exists()) {
        return res.status(404).json({ error: 'User not found' });
      }

      const userData = snap.val();
      const currentTopics = userData.topics || [];
      
      let topicsToUnsubscribe;
      if (topics) {
        topicsToUnsubscribe = Array.isArray(topics) ? topics : [topics];
      } else {
        // Unsubscribe from all except default
        topicsToUnsubscribe = currentTopics.filter(t => t !== DEFAULT_TOPIC);
      }

      // Remove topics
      const remainingTopics = currentTopics.filter(t => !topicsToUnsubscribe.includes(t));
      
      // Ensure default topic stays if no other topics
      if (remainingTopics.length === 0 && !topicsToUnsubscribe.includes(DEFAULT_TOPIC)) {
        remainingTopics.push(DEFAULT_TOPIC);
      }

      await db.ref(`${NOTIFICATIONS_PATH}/${user_id}`).update({
        topics: remainingTopics,
        lastUpdated: Date.now()
      });

      return res.status(200).json({
        success: true,
        message: 'Successfully unsubscribed',
        user_id,
        unsubscribed_from: topicsToUnsubscribe,
        remaining_topics: remainingTopics,
        timestamp: Date.now()
      });
    }

    // ============================================
    // GET HISTORY - GET ?action=history&user_id=xxx
    // ============================================
    if (req.method === 'GET' && action === 'history') {
      const { user_id, limit = NOTIFICATION_HISTORY_LIMIT, offset = 0, sort = 'desc', delivery_type } = req.query;

      if (!user_id) {
        return res.status(400).json({ error: 'user_id is required' });
      }

      const snapshot = await db.ref(`${NOTIFICATION_HISTORY_PATH}/${user_id}`).once('value');
      if (!snapshot.exists()) {
        return res.status(200).json({
          success: true,
          notifications: [],
          total: 0,
          has_more: false
        });
      }

      let notifications = [];
      snapshot.forEach((child) => {
        notifications.push({
          id: child.key,
          ...child.val()
        });
      });

      // Apply filters
      if (delivery_type) {
        notifications = notifications.filter(n => n.delivery_type === delivery_type);
      }

      // Sort
      notifications.sort((a, b) => sort === 'desc' ? b.timestamp - a.timestamp : a.timestamp - b.timestamp);

      const startIndex = parseInt(offset);
      const endIndex = startIndex + parseInt(limit);

      const paginated = notifications.slice(startIndex, endIndex);

      return res.status(200).json({
        success: true,
        notifications: paginated,
        total: notifications.length,
        has_more: notifications.length > endIndex,
        limit: parseInt(limit),
        offset: parseInt(offset)
      });
    }

    // ============================================
    // GET SINGLE NOTIFICATION - GET ?action=notification&user_id=xxx&notification_id=xxx
    // ============================================
    if (req.method === 'GET' && action === 'notification') {
      const { user_id, notification_id } = req.query;

      if (!user_id || !notification_id) {
        return res.status(400).json({ 
          error: 'user_id and notification_id are required' 
        });
      }

      const snapshot = await db.ref(`${NOTIFICATION_HISTORY_PATH}/${user_id}/${notification_id}`).once('value');
      if (!snapshot.exists()) {
        return res.status(404).json({ error: 'Notification not found' });
      }

      // Mark as read
      await db.ref(`${NOTIFICATION_HISTORY_PATH}/${user_id}/${notification_id}/read`).set(true);

      return res.status(200).json({
        success: true,
        notification: {
          id: notification_id,
          ...snapshot.val()
        }
      });
    }

    // ============================================
    // MARK AS READ - PUT ?action=read&user_id=xxx&notification_id=xxx
    // ============================================
    if (req.method === 'PUT' && action === 'read') {
      const { user_id, notification_id } = req.query;

      if (!user_id || !notification_id) {
        return res.status(400).json({ 
          error: 'user_id and notification_id are required' 
        });
      }

      const snapshot = await db.ref(`${NOTIFICATION_HISTORY_PATH}/${user_id}/${notification_id}`).once('value');
      if (!snapshot.exists()) {
        return res.status(404).json({ error: 'Notification not found' });
      }

      await db.ref(`${NOTIFICATION_HISTORY_PATH}/${user_id}/${notification_id}/read`).set(true);

      return res.status(200).json({
        success: true,
        message: 'Notification marked as read',
        notification_id
      });
    }

    // ============================================
    // MARK ALL AS READ - PUT ?action=read-all&user_id=xxx
    // ============================================
    if (req.method === 'PUT' && action === 'read-all') {
      const { user_id } = req.query;

      if (!user_id) {
        return res.status(400).json({ error: 'user_id is required' });
      }

      const snapshot = await db.ref(`${NOTIFICATION_HISTORY_PATH}/${user_id}`).once('value');
      if (!snapshot.exists()) {
        return res.status(200).json({
          success: true,
          message: 'No notifications to mark as read',
          count: 0
        });
      }

      const updates = {};
      snapshot.forEach((child) => {
        updates[`${child.key}/read`] = true;
      });

      await db.ref(`${NOTIFICATION_HISTORY_PATH}/${user_id}`).update(updates);

      return res.status(200).json({
        success: true,
        message: 'All notifications marked as read',
        count: snapshot.numChildren()
      });
    }

    // ============================================
    // DELETE NOTIFICATION - DELETE ?action=notification&user_id=xxx&notification_id=xxx
    // ============================================
    if (req.method === 'DELETE' && action === 'notification') {
      const { user_id, notification_id } = req.query;

      if (!user_id || !notification_id) {
        return res.status(400).json({ 
          error: 'user_id and notification_id are required' 
        });
      }

      const snapshot = await db.ref(`${NOTIFICATION_HISTORY_PATH}/${user_id}/${notification_id}`).once('value');
      if (!snapshot.exists()) {
        return res.status(404).json({ error: 'Notification not found' });
      }

      await db.ref(`${NOTIFICATION_HISTORY_PATH}/${user_id}/${notification_id}`).remove();

      return res.status(200).json({
        success: true,
        message: 'Notification deleted',
        notification_id
      });
    }

    // ============================================
    // DELETE ALL HISTORY - DELETE ?action=history&user_id=xxx&all=true
    // ============================================
    if (req.method === 'DELETE' && action === 'history') {
      const { user_id, all } = req.query;

      if (!user_id) {
        return res.status(400).json({ error: 'user_id is required' });
      }

      if (all === 'true') {
        await db.ref(`${NOTIFICATION_HISTORY_PATH}/${user_id}`).remove();
        return res.status(200).json({
          success: true,
          message: 'All notifications deleted',
          user_id
        });
      }

      return res.status(400).json({ 
        error: 'Set all=true to delete all history' 
      });
    }

    // ============================================
    // GET UNREAD COUNT - GET ?action=unread&user_id=xxx
    // ============================================
    if (req.method === 'GET' && action === 'unread') {
      const { user_id } = req.query;

      if (!user_id) {
        return res.status(400).json({ error: 'user_id is required' });
      }

      const snapshot = await db.ref(`${NOTIFICATION_HISTORY_PATH}/${user_id}`).once('value');
      if (!snapshot.exists()) {
        return res.status(200).json({
          success: true,
          user_id,
          unread_count: 0
        });
      }

      let unreadCount = 0;
      snapshot.forEach((child) => {
        const notification = child.val();
        if (!notification.read) {
          unreadCount++;
        }
      });

      return res.status(200).json({
        success: true,
        user_id,
        unread_count: unreadCount
      });
    }

    // ============================================
    // GET COUNT - GET ?action=count&user_id=xxx
    // ============================================
    if (req.method === 'GET' && action === 'count') {
      const { user_id } = req.query;

      if (!user_id) {
        return res.status(400).json({ error: 'user_id is required' });
      }

      const snapshot = await db.ref(`${NOTIFICATION_HISTORY_PATH}/${user_id}`).once('value');
      const count = snapshot.exists() ? snapshot.numChildren() : 0;

      return res.status(200).json({
        success: true,
        user_id,
        count,
        limit: NOTIFICATION_HISTORY_LIMIT,
        has_more_history: count >= NOTIFICATION_HISTORY_LIMIT
      });
    }

    // ============================================
    // GET USER TOPICS - GET ?action=topics&user_id=xxx
    // ============================================
    if (req.method === 'GET' && action === 'topics') {
      const { user_id } = req.query;

      if (!user_id) {
        return res.status(400).json({ error: 'user_id is required' });
      }

      const snapshot = await db.ref(`${NOTIFICATIONS_PATH}/${user_id}`).once('value');
      if (!snapshot.exists()) {
        return res.status(404).json({ 
          success: false,
          error: 'User not found' 
        });
      }

      const userData = snapshot.val();
      return res.status(200).json({
        success: true,
        user_id,
        topics: userData.topics || [],
        token: userData.token ? 'present' : 'missing',
        lastUpdated: userData.lastUpdated
      });
    }

    // ============================================
    // GET USER INFO - GET ?action=user&user_id=xxx
    // ============================================
    if (req.method === 'GET' && action === 'user') {
      const { user_id } = req.query;

      if (!user_id) {
        return res.status(400).json({ error: 'user_id is required' });
      }

      const snapshot = await db.ref(`${NOTIFICATIONS_PATH}/${user_id}`).once('value');
      if (!snapshot.exists()) {
        return res.status(404).json({ error: 'User not found' });
      }

      return res.status(200).json({
        success: true,
        user_id,
        ...snapshot.val()
      });
    }

    // ============================================
    // MIGRATE USERS - POST ?action=migrate
    // ============================================
    if (req.method === 'POST' && action === 'migrate') {
      const { from_topic, to_topic } = req.body;

      const sourceTopic = from_topic || DEFAULT_TOPIC;
      const targetTopic = to_topic || DEFAULT_TOPIC;

      const snap = await db.ref(NOTIFICATIONS_PATH).once('value');
      if (!snap.exists()) {
        return res.status(200).json({
          success: true,
          message: 'No users to migrate',
          updated: 0
        });
      }

      let updated = 0;
      const promises = [];

      snap.forEach((child) => {
        const userData = child.val();
        if (userData.topics && Array.isArray(userData.topics)) {
          if (userData.topics.includes(sourceTopic) && !userData.topics.includes(targetTopic)) {
            const updatedTopics = [...userData.topics, targetTopic];
            promises.push(
              db.ref(`${NOTIFICATIONS_PATH}/${child.key}`).update({
                topics: updatedTopics,
                lastUpdated: Date.now()
              }).then(() => updated++)
            );
          }
        }
      });

      await Promise.all(promises);

      return res.status(200).json({
        success: true,
        message: 'Migration completed',
        updated_users: updated,
        source_topic: sourceTopic,
        target_topic: targetTopic,
        total_users: snap.numChildren()
      });
    }

    // ============================================
    // GET TOPIC SUBSCRIBERS - GET ?action=subscribers&topic=xxx
    // ============================================
    if (req.method === 'GET' && action === 'subscribers') {
      const { topic } = req.query;

      if (!topic) {
        return res.status(400).json({ error: 'topic is required' });
      }

      const userIds = await getUsersByTopic(topic);

      return res.status(200).json({
        success: true,
        topic,
        subscribers: userIds,
        count: userIds.length
      });
    }

    // ============================================
    // 404 - Action not found
    // ============================================
    return res.status(404).json({
      error: 'Action not found',
      available_actions: [
        'send-topic',
        'send-user', 
        'send-all',
        'subscribe',
        'unsubscribe',
        'history',
        'notification',
        'read',
        'read-all',
        'unread',
        'count',
        'topics',
        'user',
        'migrate',
        'subscribers'
      ]
    });

  } catch (error) {
    console.error('Notifications API Error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}