import { db } from "../utils/firebase.js";

// ============================================
// Configuration
// ============================================
const ALLOWED_EXTENSIONS = ['html', 'css', 'js', 'txt', 'json'];
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB for files
const MAX_IMAGE_SIZE = 16 * 1024 * 1024; // 16MB for images (ImgBB limit)
const DB_PATH = 'Dev-HostedFiles';
const IMAGE_DB_PATH = 'Dev-HostedImages';
const ANALYTICS_PATH = 'Dev-Analytics';

// ImgBB Configuration
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
const IMGBB_API_URL = 'https://api.imgbb.com/1/upload';

// ============================================
// Analytics Helper Functions
// ============================================

async function logAnalytics(eventType, data) {
  try {
    const now = Date.now();
    const date = new Date(now);
    const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const hourKey = String(date.getHours()).padStart(2, '0');
    
    // Generate unique ID for this event
    const eventId = `${now}_${Math.random().toString(36).substring(2, 10)}`;
    const eventRef = db.ref(`${ANALYTICS_PATH}/events/${eventId}`);
    
    const analyticsData = {
      event_type: eventType,
      timestamp: now,
      date: dateKey,
      hour: hourKey,
      day_of_week: date.getDay(),
      month: date.getMonth() + 1,
      year: date.getFullYear(),
      ...data
    };
    
    await eventRef.set(analyticsData);
    
    // Update aggregates
    await updateAggregates(eventType, data);
    await updateDailyStats(dateKey, eventType, data);
    await updateHourlyStats(dateKey, hourKey, eventType, data);
    
    return true;
  } catch (error) {
    console.error('Analytics logging error:', error);
    return false;
  }
}

async function updateAggregates(eventType, data) {
  const aggregateRef = db.ref(`${ANALYTICS_PATH}/aggregates/${eventType}`);
  const snapshot = await aggregateRef.once('value');
  
  if (snapshot.exists()) {
    const current = snapshot.val();
    await aggregateRef.update({
      count: (current.count || 0) + 1,
      last_updated: Date.now()
    });
  } else {
    await aggregateRef.set({
      count: 1,
      first_seen: Date.now(),
      last_updated: Date.now()
    });
  }
}

async function updateDailyStats(dateKey, eventType, data) {
  const dailyRef = db.ref(`${ANALYTICS_PATH}/daily/${dateKey}/${eventType}`);
  const snapshot = await dailyRef.once('value');
  
  let stats = snapshot.exists() ? snapshot.val() : { count: 0 };
  
  // Update counts based on event type
  stats.count = (stats.count || 0) + 1;
  stats.last_updated = Date.now();
  
  // Track unique users
  if (data.user_id) {
    const users = stats.users || [];
    if (!users.includes(data.user_id)) {
      users.push(data.user_id);
      stats.unique_users = users.length;
    }
    stats.users = users;
  }
  
  // Track unique keys/projects
  if (data.key) {
    const keys = stats.keys || [];
    if (!keys.includes(data.key)) {
      keys.push(data.key);
      stats.unique_projects = keys.length;
    }
    stats.keys = keys;
  }
  
  // Track file types
  if (data.file_type) {
    const types = stats.file_types || {};
    types[data.file_type] = (types[data.file_type] || 0) + 1;
    stats.file_types = types;
  }
  
  // Track sizes
  if (data.size) {
    stats.total_size = (stats.total_size || 0) + data.size;
    stats.average_size = stats.total_size / stats.count;
  }
  
  await dailyRef.set(stats);
}

async function updateHourlyStats(dateKey, hourKey, eventType, data) {
  const hourlyRef = db.ref(`${ANALYTICS_PATH}/hourly/${dateKey}/${hourKey}/${eventType}`);
  const snapshot = await hourlyRef.once('value');
  
  let stats = snapshot.exists() ? snapshot.val() : { count: 0 };
  stats.count = (stats.count || 0) + 1;
  stats.last_updated = Date.now();
  
  await hourlyRef.set(stats);
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

function getReferer(req) {
  return req.headers['referer'] || req.headers['origin'] || 'direct';
}

// ============================================
// Helper Functions
// ============================================

function getFileExtension(filename) {
  const parts = filename.split('.');
  if (parts.length < 2) return null;
  const ext = parts.pop().toLowerCase();
  return ALLOWED_EXTENSIONS.includes(ext) ? ext : null;
}

function getContentType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const types = {
    'html': 'text/html',
    'css': 'text/css',
    'js': 'application/javascript',
    'json': 'application/json',
    'txt': 'text/plain'
  };
  return types[ext] || 'text/plain';
}

function generateFileId(user_id, key, filename) {
  return `${user_id}/${key}/${filename}`;
}

function generateImageId(user_id, key, imageId) {
  return `${user_id}/${key}/${imageId}`;
}

// ============================================
// ImgBB Upload Function
// ============================================

async function uploadToImgBB(imageData, filename) {
  if (!IMGBB_API_KEY) {
    throw new Error('ImgBB API key not configured');
  }

  const formData = new FormData();
  formData.append('key', IMGBB_API_KEY);
  formData.append('image', imageData);
  formData.append('name', filename || 'image');

  const response = await fetch(IMGBB_API_URL, {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    throw new Error(`ImgBB upload failed: ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.success) {
    throw new Error(`ImgBB error: ${data.error?.message || 'Unknown error'}`);
  }

  return {
    image_id: data.data.id,
    url: data.data.url,
    display_url: data.data.display_url,
    thumb_url: data.data.thumb?.url || data.data.url,
    size: data.data.size,
    width: data.data.width,
    height: data.data.height,
    mime_type: data.data.image?.mime_type || 'image/*'
  };
}

// ============================================
// Main API Handler
// ============================================

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const baseUrl = `https://${req.headers.host}`;
  const clientIP = getClientIP(req);
  const userAgent = getUserAgent(req);
  const referer = getReferer(req);

  try {
    // ============================================
    // GET ANALYTICS - /api/host?action=analytics
    // ============================================
    if (req.method === 'GET' && req.query.action === 'analytics') {
      const { user_id, key, period = 'today' } = req.query;
      
      if (!user_id || !key) {
        return res.status(400).json({ 
          error: 'user_id and key are required' 
        });
      }
      
      let dateKey;
      if (period === 'today') {
        const now = new Date();
        dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      } else if (period === 'week') {
        // Get last 7 days
        const analytics = await getWeeklyAnalytics(user_id, key);
        return res.status(200).json(analytics);
      } else if (period === 'month') {
        // Get last 30 days
        const analytics = await getMonthlyAnalytics(user_id, key);
        return res.status(200).json(analytics);
      } else {
        dateKey = period;
      }
      
      const analyticsRef = db.ref(`${ANALYTICS_PATH}/daily/${dateKey}`);
      const snapshot = await analyticsRef.once('value');
      
      if (!snapshot.exists()) {
        return res.status(200).json({
          success: true,
          date: dateKey,
          period: period,
          events: {},
          total_events: 0
        });
      }
      
      const data = snapshot.val();
      const events = {};
      let total = 0;
      
      // Filter events by user_id and key
      Object.keys(data).forEach(eventType => {
        const eventData = data[eventType];
        const userEvents = eventData.users || [];
        const keyEvents = eventData.keys || [];
        
        if (userEvents.includes(user_id) || keyEvents.includes(key)) {
          events[eventType] = eventData;
          total += eventData.count || 0;
        }
      });
      
      return res.status(200).json({
        success: true,
        date: dateKey,
        period: period,
        events,
        total_events: total
      });
    }

    // ============================================
    // GET ANALYTICS SUMMARY - /api/host?action=analytics-summary
    // ============================================
    if (req.method === 'GET' && req.query.action === 'analytics-summary') {
      const { user_id, key } = req.query;
      
      if (!user_id || !key) {
        return res.status(400).json({ 
          error: 'user_id and key are required' 
        });
      }
      
      const summary = await getAnalyticsSummary(user_id, key);
      
      return res.status(200).json({
        success: true,
        user_id,
        key,
        summary
      });
    }

    // ============================================
    // IMAGE ROUTES
    // ============================================

    // POST - Upload Image
    if (req.method === 'POST' && req.url?.includes('/image')) {
      let user_id, key, imageData, name, filename;

      if (req.headers['content-type']?.includes('multipart/form-data')) {
        // Handle FormData
        const formData = await new Promise((resolve, reject) => {
          const chunks = [];
          req.on('data', chunk => chunks.push(chunk));
          req.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const boundary = req.headers['content-type'].split('boundary=')[1];
            const parsed = parseMultipart(buffer, boundary);
            resolve(parsed);
          });
          req.on('error', reject);
        });

        user_id = formData.user_id;
        key = formData.key;
        name = formData.name;
        filename = formData.image?.filename || 'image.jpg';
        imageData = formData.image?.data;
      } else {
        // Handle JSON
        const body = req.body;
        user_id = body.user_id;
        key = body.key;
        name = body.name;
        filename = body.filename || 'image.jpg';
        imageData = body.image;
      }

      if (!user_id || !key || !imageData) {
        return res.status(400).json({ 
          error: 'user_id, key, and image are required' 
        });
      }

      // Check if base64 string
      if (typeof imageData === 'string' && imageData.startsWith('data:')) {
        // Already a data URL
      } else if (typeof imageData === 'string' && !imageData.startsWith('data:')) {
        // Assume it's base64 without prefix
        imageData = `data:image/jpeg;base64,${imageData}`;
      }

      // Upload to ImgBB
      try {
        const imgbbResult = await uploadToImgBB(imageData, filename);

        // Save to Firebase
        const imageId = generateImageId(user_id, key, imgbbResult.image_id);
        const imageRef = db.ref(`${IMAGE_DB_PATH}/${imageId}`);

        const now = Date.now();
        const imageRecord = {
          image_id: imgbbResult.image_id,
          user_id,
          key,
          name: name || filename,
          filename: filename,
          url: imgbbResult.url,
          display_url: imgbbResult.display_url,
          thumb_url: imgbbResult.thumb_url,
          size: imgbbResult.size,
          width: imgbbResult.width,
          height: imgbbResult.height,
          mime_type: imgbbResult.mime_type,
          created_at: now
        };

        await imageRef.set(imageRecord);

        // Log analytics
        await logAnalytics('image_upload', {
          user_id,
          key,
          filename,
          image_id: imgbbResult.image_id,
          size: imgbbResult.size,
          width: imgbbResult.width,
          height: imgbbResult.height,
          mime_type: imgbbResult.mime_type,
          file_type: 'image',
          ip: clientIP,
          user_agent: userAgent,
          referer
        });

        return res.status(201).json({
          success: true,
          message: 'Image uploaded successfully',
          ...imageRecord
        });
      } catch (error) {
        console.error('ImgBB upload error:', error);
        
        // Log error analytics
        await logAnalytics('image_upload_error', {
          user_id,
          key,
          filename,
          error: error.message,
          ip: clientIP,
          user_agent: userAgent
        });
        
        return res.status(500).json({ 
          error: 'Failed to upload image to ImgBB',
          details: error.message 
        });
      }
    }

    // GET - Retrieve Image
    if (req.method === 'GET' && req.query.action !== 'list' && req.url?.includes('/image')) {
      const { user_id, key, image_id } = req.query;

      if (!user_id || !key || !image_id) {
        return res.status(400).json({ 
          error: 'user_id, key, and image_id are required' 
        });
      }

      const imageId = generateImageId(user_id, key, image_id);
      const imageRef = db.ref(`${IMAGE_DB_PATH}/${imageId}`);
      const snapshot = await imageRef.once('value');

      if (!snapshot.exists()) {
        return res.status(404).json({ error: 'Image not found' });
      }

      const imageData = snapshot.val();

      // Log analytics
      await logAnalytics('image_view', {
        user_id,
        key,
        image_id,
        filename: imageData.filename,
        size: imageData.size,
        ip: clientIP,
        user_agent: userAgent,
        referer
      });

      return res.status(200).json({
        success: true,
        image: imageData
      });
    }

    // DELETE - Delete Image
    if (req.method === 'DELETE' && req.url?.includes('/image')) {
      const { user_id, key, image_id } = req.query;

      if (!user_id || !key || !image_id) {
        return res.status(400).json({ 
          error: 'user_id, key, and image_id are required' 
        });
      }

      const imageId = generateImageId(user_id, key, image_id);
      const imageRef = db.ref(`${IMAGE_DB_PATH}/${imageId}`);

      const existing = await imageRef.once('value');
      if (!existing.exists()) {
        return res.status(404).json({ error: 'Image not found' });
      }

      const imageData = existing.val();
      await imageRef.remove();

      // Log analytics
      await logAnalytics('image_delete', {
        user_id,
        key,
        image_id,
        filename: imageData.filename,
        size: imageData.size,
        ip: clientIP,
        user_agent: userAgent
      });

      return res.status(200).json({
        success: true,
        message: 'Image deleted successfully',
        image_id: image_id
      });
    }

    // GET - List Images
    if (req.method === 'GET' && req.query.action === 'list' && req.url?.includes('/image')) {
      const { user_id, key } = req.query;

      if (!user_id || !key) {
        return res.status(400).json({ 
          error: 'user_id and key are required' 
        });
      }

      const imagesRef = db.ref(IMAGE_DB_PATH);
      const snapshot = await imagesRef.once('value');

      const images = [];
      if (snapshot.exists()) {
        snapshot.forEach((childSnapshot) => {
          const imageData = childSnapshot.val();
          if (imageData.user_id === user_id && imageData.key === key) {
            images.push(imageData);
          }
        });
      }

      // Log analytics
      await logAnalytics('image_list', {
        user_id,
        key,
        count: images.length,
        ip: clientIP,
        user_agent: userAgent
      });

      return res.status(200).json({
        success: true,
        user_id,
        key,
        images,
        count: images.length
      });
    }

    // ============================================
    // FILE ROUTES
    // ============================================

    // GET: Retrieve file
    if (req.method === 'GET' && !req.url?.includes('/image')) {
      const { user_id, key, filename } = req.query;

      if (!user_id || !key) {
        return res.status(400).json({ 
          error: 'user_id and key are required' 
        });
      }

      const targetFile = filename || 'index.html';
      const fileId = generateFileId(user_id, key, targetFile);
      const fileRef = db.ref(`${DB_PATH}/${fileId}`);
      const snapshot = await fileRef.once('value');

      if (!snapshot.exists()) {
        return res.status(404).json({ 
          error: 'File not found',
          message: `No file found at ${user_id}/${key}/${targetFile}`
        });
      }

      const fileData = snapshot.val();

      if (fileData.expiry && fileData.expiry < Date.now()) {
        return res.status(410).json({ error: 'File has expired' });
      }

      // Log analytics
      const fileExt = targetFile.split('.').pop().toLowerCase();
      await logAnalytics('file_view', {
        user_id,
        key,
        filename: targetFile,
        file_type: fileExt,
        size: fileData.size || fileData.code?.length || 0,
        ip: clientIP,
        user_agent: userAgent,
        referer
      });

      res.setHeader('Content-Type', getContentType(targetFile));
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(200).send(fileData.code || fileData.content);
    }

    // POST: Create new file
    if (req.method === 'POST' && !req.url?.includes('/image')) {
      const { user_id, key, filename, code, name } = req.body;

      if (!user_id || !key || !filename || !code) {
        return res.status(400).json({ 
          error: 'user_id, key, filename, and code are required' 
        });
      }

      const ext = getFileExtension(filename);
      if (!ext) {
        return res.status(400).json({ 
          error: `File type not allowed. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}` 
        });
      }

      if (code.length > MAX_FILE_SIZE) {
        return res.status(400).json({ 
          error: `File too large. Max ${MAX_FILE_SIZE / 1024 / 1024}MB` 
        });
      }

      const fileId = generateFileId(user_id, key, filename);
      const fileRef = db.ref(`${DB_PATH}/${fileId}`);

      const existing = await fileRef.once('value');
      if (existing.exists()) {
        return res.status(409).json({ 
          error: 'File already exists. Use PUT to update.' 
        });
      }

      const now = Date.now();
      const fileData = {
        user_id,
        key,
        filename,
        name: name || filename,
        code: code,
        content: code,
        size: code.length,
        created_at: now,
        updated_at: now,
        hosttime: now,
        expiry: null
      };

      await fileRef.set(fileData);

      const hostedUrl = `${baseUrl}/api/host?user_id=${user_id}&key=${key}`;
      const directUrl = `${baseUrl}/${user_id}/${key}`;

      // Log analytics
      await logAnalytics('file_upload', {
        user_id,
        key,
        filename,
        file_type: ext,
        size: code.length,
        name: name || filename,
        ip: clientIP,
        user_agent: userAgent,
        referer
      });

      return res.status(201).json({
        success: true,
        message: 'Project created successfully',
        url: hostedUrl,
        direct_url: directUrl,
        name: name || filename,
        key: key,
        hosttime: String(now),
        filename: filename,
        size: code.length
      });
    }

    // PUT: Update existing file
    if (req.method === 'PUT') {
      const { user_id, key, filename, code, name } = req.body;

      if (!user_id || !key || !filename || !code) {
        return res.status(400).json({ 
          error: 'user_id, key, filename, and code are required' 
        });
      }

      const fileId = generateFileId(user_id, key, filename);
      const fileRef = db.ref(`${DB_PATH}/${fileId}`);

      const existing = await fileRef.once('value');
      if (!existing.exists()) {
        return res.status(404).json({ error: 'File not found' });
      }

      const existingData = existing.val();
      const now = Date.now();

      const updates = {
        code: code,
        content: code,
        size: code.length,
        name: name || existingData.name,
        updated_at: now,
        hosttime: now
      };

      await fileRef.update(updates);

      const hostedUrl = `${baseUrl}/api/host?user_id=${user_id}&key=${key}`;
      const ext = filename.split('.').pop().toLowerCase();

      // Log analytics
      await logAnalytics('file_update', {
        user_id,
        key,
        filename,
        file_type: ext,
        size: code.length,
        old_size: existingData.size || existingData.code?.length || 0,
        ip: clientIP,
        user_agent: userAgent
      });

      return res.status(200).json({
        success: true,
        message: 'Project updated successfully',
        url: hostedUrl,
        name: updates.name,
        key: key,
        hosttime: String(now),
        filename: filename
      });
    }

    // DELETE: Delete file
    if (req.method === 'DELETE' && !req.url?.includes('/image')) {
      const { user_id, key, filename } = req.query;

      if (!user_id || !key || !filename) {
        return res.status(400).json({ 
          error: 'user_id, key, and filename are required' 
        });
      }

      const fileId = generateFileId(user_id, key, filename);
      const fileRef = db.ref(`${DB_PATH}/${fileId}`);

      const existing = await fileRef.once('value');
      if (!existing.exists()) {
        return res.status(404).json({ error: 'File not found' });
      }

      const fileData = existing.val();
      await fileRef.remove();

      const ext = filename.split('.').pop().toLowerCase();

      // Log analytics
      await logAnalytics('file_delete', {
        user_id,
        key,
        filename,
        file_type: ext,
        size: fileData.size || fileData.code?.length || 0,
        ip: clientIP,
        user_agent: userAgent
      });

      return res.status(200).json({
        success: true,
        message: 'Project deleted successfully'
      });
    }

    // GET: List all projects
    if (req.method === 'GET' && req.query.action === 'list' && !req.url?.includes('/image')) {
      const { user_id, key } = req.query;

      if (!user_id || !key) {
        return res.status(400).json({ 
          error: 'user_id and key are required' 
        });
      }

      const filesRef = db.ref(DB_PATH);
      const snapshot = await filesRef.once('value');

      const projects = [];
      if (snapshot.exists()) {
        snapshot.forEach((childSnapshot) => {
          const fileData = childSnapshot.val();
          if (fileData.user_id === user_id && fileData.key === key) {
            projects.push({
              name: fileData.name,
              filename: fileData.filename,
              url: `${baseUrl}/api/host?user_id=${user_id}&key=${key}&filename=${fileData.filename}`,
              direct_url: `${baseUrl}/${user_id}/${key}/${fileData.filename}`,
              hosttime: fileData.hosttime,
              created_at: fileData.created_at,
              size: fileData.size
            });
          }
        });
      }

      // Log analytics
      await logAnalytics('project_list', {
        user_id,
        key,
        count: projects.length,
        ip: clientIP,
        user_agent: userAgent
      });

      return res.status(200).json({
        success: true,
        user_id: user_id,
        key: key,
        projects: projects,
        count: projects.length,
        base_url: `${baseUrl}/api/host?user_id=${user_id}&key=${key}`
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('Host API Error:', error);
    
    // Log error analytics
    await logAnalytics('api_error', {
      error: error.message,
      stack: error.stack,
      ip: clientIP,
      user_agent: userAgent,
      url: req.url,
      method: req.method
    });
    
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ============================================
// Analytics Helper Functions (continued)
// ============================================

async function getWeeklyAnalytics(user_id, key) {
  const now = new Date();
  const weekData = {};
  let totalEvents = 0;
  
  for (let i = 0; i < 7; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    
    const analyticsRef = db.ref(`${ANALYTICS_PATH}/daily/${dateKey}`);
    const snapshot = await analyticsRef.once('value');
    
    if (snapshot.exists()) {
      const data = snapshot.val();
      const dayEvents = {};
      let dayTotal = 0;
      
      Object.keys(data).forEach(eventType => {
        const eventData = data[eventType];
        const userEvents = eventData.users || [];
        const keyEvents = eventData.keys || [];
        
        if (userEvents.includes(user_id) || keyEvents.includes(key)) {
          dayEvents[eventType] = eventData;
          dayTotal += eventData.count || 0;
        }
      });
      
      weekData[dateKey] = {
        events: dayEvents,
        total: dayTotal
      };
      totalEvents += dayTotal;
    } else {
      weekData[dateKey] = {
        events: {},
        total: 0
      };
    }
  }
  
  return {
    success: true,
    user_id,
    key,
    period: 'week',
    data: weekData,
    total_events: totalEvents
  };
}

async function getMonthlyAnalytics(user_id, key) {
  const now = new Date();
  const monthData = {};
  let totalEvents = 0;
  
  for (let i = 0; i < 30; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    
    const analyticsRef = db.ref(`${ANALYTICS_PATH}/daily/${dateKey}`);
    const snapshot = await analyticsRef.once('value');
    
    if (snapshot.exists()) {
      const data = snapshot.val();
      const dayEvents = {};
      let dayTotal = 0;
      
      Object.keys(data).forEach(eventType => {
        const eventData = data[eventType];
        const userEvents = eventData.users || [];
        const keyEvents = eventData.keys || [];
        
        if (userEvents.includes(user_id) || keyEvents.includes(key)) {
          dayEvents[eventType] = eventData;
          dayTotal += eventData.count || 0;
        }
      });
      
      monthData[dateKey] = {
        events: dayEvents,
        total: dayTotal
      };
      totalEvents += dayTotal;
    } else {
      monthData[dateKey] = {
        events: {},
        total: 0
      };
    }
  }
  
  return {
    success: true,
    user_id,
    key,
    period: 'month',
    data: monthData,
    total_events: totalEvents
  };
}

async function getAnalyticsSummary(user_id, key) {
  const summary = {
    total_views: 0,
    total_uploads: 0,
    total_deletions: 0,
    total_updates: 0,
    unique_visitors: new Set(),
    file_types: {},
    total_storage: 0,
    last_7_days: 0,
    last_30_days: 0
  };
  
  // Get all analytics events for this user/key
  const analyticsRef = db.ref(ANALYTICS_PATH);
  const snapshot = await analyticsRef.once('value');
  
  if (snapshot.exists()) {
    const data = snapshot.val();
    
    // Process events
    if (data.events) {
      Object.keys(data.events).forEach(eventId => {
        const event = data.events[eventId];
        if (event.user_id === user_id && event.key === key) {
          // Count by type
          switch (event.event_type) {
            case 'file_view':
            case 'image_view':
              summary.total_views++;
              break;
            case 'file_upload':
            case 'image_upload':
              summary.total_uploads++;
              summary.total_storage += event.size || 0;
              break;
            case 'file_delete':
            case 'image_delete':
              summary.total_deletions++;
              break;
            case 'file_update':
              summary.total_updates++;
              break;
          }
          
          // Track unique visitors
          if (event.ip) {
            summary.unique_visitors.add(event.ip);
          }
          
          // Track file types
          if (event.file_type) {
            summary.file_types[event.file_type] = (summary.file_types[event.file_type] || 0) + 1;
          }
          
          // Count last 7 days
          if (event.timestamp > Date.now() - 7 * 24 * 60 * 60 * 1000) {
            summary.last_7_days++;
          }
          
          // Count last 30 days
          if (event.timestamp > Date.now() - 30 * 24 * 60 * 60 * 1000) {
            summary.last_30_days++;
          }
        }
      });
    }
  }
  
  // Get total files count
  const filesRef = db.ref(`${DB_PATH}`);
  const filesSnapshot = await filesRef.once('value');
  let totalFiles = 0;
  if (filesSnapshot.exists()) {
    filesSnapshot.forEach((childSnapshot) => {
      const fileData = childSnapshot.val();
      if (fileData.user_id === user_id && fileData.key === key) {
        totalFiles++;
      }
    });
  }
  
  // Get total images count
  const imagesRef = db.ref(`${IMAGE_DB_PATH}`);
  const imagesSnapshot = await imagesRef.once('value');
  let totalImages = 0;
  if (imagesSnapshot.exists()) {
    imagesSnapshot.forEach((childSnapshot) => {
      const imageData = childSnapshot.val();
      if (imageData.user_id === user_id && imageData.key === key) {
        totalImages++;
      }
    });
  }
  
  return {
    ...summary,
    unique_visitors: summary.unique_visitors.size,
    total_files: totalFiles,
    total_images: totalImages,
    total_items: totalFiles + totalImages,
    total_storage_mb: (summary.total_storage / 1024 / 1024).toFixed(2)
  };
}

// ============================================
// Multipart Form Data Parser Helper
// ============================================

function parseMultipart(buffer, boundary) {
  const result = {};
  const parts = buffer.toString('binary').split(`--${boundary}`);

  for (const part of parts) {
    if (part.includes('Content-Disposition: form-data')) {
      const nameMatch = part.match(/name="([^"]+)"/);
      const filenameMatch = part.match(/filename="([^"]+)"/);

      if (nameMatch) {
        const name = nameMatch[1];
        const contentStart = part.indexOf('\r\n\r\n') + 4;
        const contentEnd = part.lastIndexOf('\r\n--');
        let content = part.substring(contentStart, contentEnd);

        if (filenameMatch) {
          // It's a file
          const filename = filenameMatch[1];
          const data = Buffer.from(content, 'binary');
          result[name] = { filename, data };
        } else {
          // It's a text field
          result[name] = content;
        }
      }
    }
  }

  return result;
}