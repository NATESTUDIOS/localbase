import { db } from "../utils/firebase.js";

// ============================================
// Configuration
// ============================================
const ALLOWED_EXTENSIONS = ['html', 'css', 'js', 'txt', 'json'];
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB for files
const MAX_IMAGE_SIZE = 16 * 1024 * 1024; // 16MB for images (ImgBB limit)
const DB_PATH = 'HostedFiles';
const IMAGE_DB_PATH = 'HostedImages';

// ImgBB Configuration
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
const IMGBB_API_URL = 'https://api.imgbb.com/1/upload';

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

async function deleteFromImgBB(imageId) {
  // ImgBB doesn't have a delete API endpoint
  // Images are automatically deleted after a period (usually 6 months for free tier)
  // We'll just remove from our database
  return true;
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

  try {
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

        return res.status(201).json({
          success: true,
          message: 'Image uploaded successfully',
          ...imageRecord
        });
      } catch (error) {
        console.error('ImgBB upload error:', error);
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

      await imageRef.remove();

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

      return res.status(200).json({
        success: true,
        user_id,
        key,
        images,
        count: images.length
      });
    }

    // ============================================
    // FILE ROUTES (Same as before)
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

      await fileRef.remove();

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
    return res.status(500).json({ error: 'Internal server error' });
  }
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