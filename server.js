require('dotenv').config();
const express = require('express');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const multer = require('multer');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use('/documents', express.static('documents'));
app.use('/covers', express.static('covers'));

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'documents/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.pdf', '.doc', '.docx', '.txt'];
    const fileExt = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(fileExt)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, Word, and text files are allowed'));
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  }
});

// MySQL connection pool
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'betebrana',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Initialize database
async function initializeDatabase() {
  try {
    const connection = await pool.getConnection();
    
    // Create tables (same as SQL above)
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS books (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        author VARCHAR(255) NOT NULL,
        description TEXT,
        total_copies INT DEFAULT 1,
        available_copies INT DEFAULT 1,
        file_path VARCHAR(500),
        file_type ENUM('pdf', 'doc', 'docx', 'txt'),
        file_size INT,
        cover_image VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS rentals (
        id INT AUTO_INCREMENT PRIMARY KEY,
        book_id INT,
        user_id INT,
        rented_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        due_date TIMESTAMP,
        returned_at TIMESTAMP NULL,
        status ENUM('active', 'returned') DEFAULT 'active',
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

 // Update the queue table to track when the book becomes available for each user
await connection.execute(`
  CREATE TABLE IF NOT EXISTS queue (
    id INT AUTO_INCREMENT PRIMARY KEY,
    book_id INT,
    user_id INT,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    available_at TIMESTAMP NULL, -- When the book becomes available for this user
    expires_at TIMESTAMP NULL, -- When the reservation expires (2 days after available_at)
    status ENUM('waiting', 'available', 'expired') DEFAULT 'waiting',
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`);

    // Create documents directory if it doesn't exist
   if (!fs.existsSync('documents')) fs.mkdirSync('documents', { recursive: true });
if (!fs.existsSync('covers')) fs.mkdirSync('covers', { recursive: true });


    connection.release();
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// JWT middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
}

// Helper function to process queue when book is returned
// Update the processQueue function to handle the LIMIT parameter correctly
// Fix the processQueue function - remove parameter binding for LIMIT
async function processQueue(bookId) {
  try {
    const [books] = await pool.execute('SELECT * FROM books WHERE id = ?', [bookId]);
    if (books.length === 0) return;

    const book = books[0];
    
    if (book.available_copies > 0) {
      // Get waiting users in queue order - use template literal for LIMIT
      const [queueItems] = await pool.execute(`
          SELECT * FROM queue 
          WHERE book_id = ? AND status = 'waiting'
          ORDER BY added_at ASC 
          LIMIT ${book.available_copies}
      `, [bookId]);

      console.log(`Processing queue for book "${book.title}": ${queueItems.length} users can be moved to available status`);

      // Mark these users as having the book available
      const now = new Date();
      const expiryDate = new Date(now.getTime() + (2 * 24 * 60 * 60 * 1000)); // 2 days from now
      
      for (const queueItem of queueItems) {
        await pool.execute(
          'UPDATE queue SET status = "available", available_at = ?, expires_at = ? WHERE id = ?',
          [now, expiryDate, queueItem.id]
        );
        
        console.log(`Book "${book.title}" is now available for user ${queueItem.user_id}. Reservation expires at ${expiryDate}`);
      }
    }
  } catch (error) {
    console.error('Process queue error:', error);
  }
}
// Clean up expired queue entries (call this periodically)
async function cleanupExpiredQueue() {
  try {
    // Delete queue entries where reservation has expired
    const result = await pool.execute(`
        DELETE FROM queue 
        WHERE status = 'available' 
        AND expires_at < NOW()
    `);

    console.log(`Cleaned up ${result[0].affectedRows} expired reservations`);
    
    // Process queue for books that now have available copies
    if (result[0].affectedRows > 0) {
      // Get books that had expired reservations
      const [affectedBooks] = await pool.execute(`
          SELECT DISTINCT book_id FROM queue 
          WHERE status = 'available' 
          AND expires_at < NOW()
      `);
      
      // Process queue for each affected book
      for (const book of affectedBooks) {
        await processQueue(book.book_id);
      }
    }
    
    return result[0].affectedRows;
  } catch (error) {
    console.error('Queue cleanup error:', error);
    return 0;
  }
}
// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/reader', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reader.html'));
});
app.get('/try', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'try.html'));
});

// Test endpoint
app.get('/api/test', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT 1 as test');
    res.json({ success: true, message: 'Database connection successful', data: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Database connection failed', error: error.message });
  }
});

// Authentication endpoints
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Email, password, and name are required' });
  }

  try {
    const [existingUsers] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUsers.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await pool.execute(
      'INSERT INTO users (email, password, name) VALUES (?, ?, ?)',
      [email, hashedPassword, name]
    );

    const token = jwt.sign(
      { id: result.insertId, email, name },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      user: { id: result.insertId, email, name },
      token,
      message: 'Registration successful'
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const user = users[0];
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      user: { id: user.id, email: user.email, name: user.name },
      token,
      message: 'Login successful'
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Books endpoints with queue information
// Update the books endpoint to include queue information
// Update the books endpoint to include proper queue information
app.get('/api/books', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const [books] = await pool.execute('SELECT * FROM books');
    
    // Enhance each book with queue information for the current user
    const enhancedBooks = await Promise.all(books.map(async (book) => {
      // Get queue information for this book
      const [queueItems] = await pool.execute(`
        SELECT q.*, u.name, u.email 
        FROM queue q 
        JOIN users u ON q.user_id = u.id 
        WHERE q.book_id = ? 
        ORDER BY 
          CASE 
            WHEN q.status = 'available' THEN 1
            WHEN q.status = 'waiting' THEN 2
            ELSE 3
          END,
          q.added_at ASC
      `, [book.id]);
      
      // Find user's position and status
      const userQueueItem = queueItems.find(item => item.user_id === userId);
      const userPosition = queueItems.findIndex(item => item.user_id === userId) + 1;
      const userInQueue = !!userQueueItem;
      const isFirstInQueue = userPosition === 1 && userInQueue;
      const hasReservation = userQueueItem && userQueueItem.status === 'available';
      
      // Calculate if book is effectively available for this user
      // Book is effectively available only if user has an active reservation
      const effectiveAvailable = hasReservation;

      // Calculate time remaining for reservation
      let timeRemaining = null;
      if (hasReservation && userQueueItem.expires_at) {
        const expiryDate = new Date(userQueueItem.expires_at);
        timeRemaining = expiryDate - new Date();
      }
      
      return {
        ...book,
        queueInfo: {
          totalInQueue: queueItems.length,
          userPosition: userInQueue ? userPosition : null,
          isFirstInQueue,
          userInQueue,
          hasReservation,
          effectiveAvailable,
          timeRemaining: timeRemaining > 0 ? timeRemaining : null,
          expiresAt: userQueueItem ? userQueueItem.expires_at : null,
          availableAt: userQueueItem ? userQueueItem.available_at : null,
          queueStatus: userQueueItem ? userQueueItem.status : null,
          // Add this to help frontend logic
          canJoinQueue: !userInQueue && book.available_copies <= 0
        }
      };
    }));
    
    res.json(enhancedBooks);
  } catch (error) {
    console.error('Books fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch books' });
  }
});
// Get book document for reading
app.get('/api/books/:id/read', authenticateToken, async (req, res) => {
  const bookId = req.params.id;
  const userId = req.user.id;

  try {
    // Check if user has rented this book
    const [rentals] = await pool.execute(
      'SELECT * FROM rentals WHERE book_id = ? AND user_id = ? AND status = "active"',
      [bookId, userId]
    );

    if (rentals.length === 0) {
      return res.status(403).json({ error: 'You do not have access to this book' });
    }

    // Get book details
    const [books] = await pool.execute('SELECT * FROM books WHERE id = ?', [bookId]);
    if (books.length === 0) {
      return res.status(404).json({ error: 'Book not found' });
    }

    const book = books[0];
    
    // Return document info for the reader
    res.json({
      book: {
        id: book.id,
        title: book.title,
        author: book.author,
        file_path: book.file_path,
        file_type: book.file_type
      }
    });
  } catch (error) {
    console.error('Read book error:', error);
    res.status(500).json({ error: 'Failed to access book' });
  }
});

// Upload book endpoint (for admin)
app.post('/api/books/upload', upload.single('document'), async (req, res) => {
  try {
    const { title, author, description, total_copies } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Determine file type
    const fileExt = path.extname(file.originalname).toLowerCase();
    let fileType = 'txt';
    if (fileExt === '.pdf') fileType = 'pdf';
    else if (fileExt === '.doc') fileType = 'doc';
    else if (fileExt === '.docx') fileType = 'docx';

    // Insert book into database
    const [result] = await pool.execute(
      'INSERT INTO books (title, author, description, total_copies, available_copies, file_path, file_type, file_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [title, author, description, total_copies || 1, total_copies || 1, `/documents/${file.filename}`, fileType, file.size]
    );

    res.json({
      success: true,
      message: 'Book uploaded successfully',
      book: { id: result.insertId, title, author }
    });
  } catch (error) {
    console.error('Upload book error:', error);
    res.status(500).json({ error: 'Failed to upload book' });
  }
});

// Get user rentals
app.get('/api/user/rentals', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    console.log('Fetching rentals for user:', userId);
    
    const [rentals] = await pool.execute(`
        SELECT r.*, b.title, b.author, b.description 
        FROM rentals r 
        JOIN books b ON r.book_id = b.id 
        WHERE r.user_id = ? AND r.status = 'active'
        ORDER BY r.rented_at DESC
    `, [userId]);

    console.log('Found rentals:', rentals);
    res.json(rentals);
  } catch (error) {
    console.error('Fetch rentals error:', error);
    res.status(500).json({ error: 'Failed to fetch rentals: ' + error.message });
  }
});

// Get user queue
app.get('/api/user/queue', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    console.log('Fetching queue for user:', userId);
    
    const [queue] = await pool.execute(`
        SELECT q.*, b.title, b.author, b.description 
        FROM queue q 
        JOIN books b ON q.book_id = b.id 
        WHERE q.user_id = ?
        ORDER BY q.added_at DESC
    `, [userId]);

    console.log('Found queue items:', queue);
    res.json(queue);
  } catch (error) {
    console.error('Fetch queue error:', error);
    res.status(500).json({ error: 'Failed to fetch queue: ' + error.message });
  }
});

// Add to queue endpoint
// Update the add to queue endpoint
app.post('/api/queue/add', authenticateToken, async (req, res) => {
    const { bookId } = req.body;
    const userId = req.user.id;

    try {
        // Check if book exists
        const [books] = await pool.execute('SELECT * FROM books WHERE id = ?', [bookId]);
        if (books.length === 0) {
            return res.status(404).json({ error: 'Book not found' });
        }

        const book = books[0];
        
        // Get queue information to check if there are people waiting
        const [queueItems] = await pool.execute(`
            SELECT * FROM queue 
            WHERE book_id = ? 
            ORDER BY added_at ASC
        `, [bookId]);

        // Allow joining queue if:
        // 1. Book is unavailable (available_copies <= 0), OR
        // 2. Book is available but there are people in queue (meaning it's reserved for first person)
        const canJoinQueue = book.available_copies <= 0 || queueItems.length > 0;

        if (!canJoinQueue && book.available_copies > 0) {
            return res.status(400).json({ 
                error: 'Book is available for direct rental. No need to join queue.',
                available: true 
            });
        }

        // Check if already in queue
        const [existingQueue] = await pool.execute(
            'SELECT * FROM queue WHERE book_id = ? AND user_id = ?',
            [bookId, userId]
        );

        if (existingQueue.length > 0) {
            return res.status(400).json({ error: 'Book already in your queue' });
        }

        // Check if user already has active rental
        const [existingRentals] = await pool.execute(
            'SELECT * FROM rentals WHERE book_id = ? AND user_id = ? AND status = "active"',
            [bookId, userId]
        );

        if (existingRentals.length > 0) {
            return res.status(400).json({ error: 'You already have this book rented' });
        }

        // Add to queue
        await pool.execute(
            'INSERT INTO queue (book_id, user_id) VALUES (?, ?)',
            [bookId, userId]
        );

        // Get updated queue position
        const [updatedQueueItems] = await pool.execute(`
            SELECT * FROM queue 
            WHERE book_id = ? 
            ORDER BY added_at ASC
        `, [bookId]);

        const position = updatedQueueItems.findIndex(item => item.user_id === userId) + 1;

        res.json({ 
            success: true, 
            message: 'Book added to queue',
            position,
            totalInQueue: updatedQueueItems.length,
            availableCopies: book.available_copies
        });
    } catch (error) {
        console.error('Add to queue error:', error);
        res.status(500).json({ error: 'Failed to add to queue' });
    }
});
// Remove from queue endpoint
app.delete('/api/queue/remove', authenticateToken, async (req, res) => {
  const { queueId } = req.body;
  const userId = req.user.id;

  try {
    await pool.execute(
      'DELETE FROM queue WHERE id = ? AND user_id = ?',
      [queueId, userId]
    );

    res.json({ success: true, message: 'Removed from queue' });
  } catch (error) {
    console.error('Remove from queue error:', error);
    res.status(500).json({ error: 'Failed to remove from queue' });
  }
});

app.post('/api/books/return', authenticateToken, async (req, res) => {
  const { rentalId, bookId } = req.body;
  const userId = req.user.id;

  try {
    // Verify rental belongs to user
    const [rentals] = await pool.execute(
      'SELECT * FROM rentals WHERE id = ? AND user_id = ? AND status = "active"',
      [rentalId, userId]
    );

    if (rentals.length === 0) {
      return res.status(404).json({ error: 'Rental not found' });
    }

    // Update rental status
    await pool.execute(
      'UPDATE rentals SET status = "returned", returned_at = CURRENT_TIMESTAMP WHERE id = ?',
      [rentalId]
    );

    // Update book availability
    await pool.execute(
      'UPDATE books SET available_copies = available_copies + 1 WHERE id = ?',
      [bookId]
    );

    console.log(`Book ${bookId} returned. Processing queue...`);
    
    // Process queue for this book IMMEDIATELY
    await processQueue(bookId);

    res.json({ success: true, message: 'Book returned successfully' });
  } catch (error) {
    console.error('Return book error:', error);
    res.status(500).json({ error: 'Failed to return book' });
  }
});
// Add a new endpoint to manually trigger queue processing (for testing)
app.post('/api/queue/process/:bookId', authenticateToken, async (req, res) => {
  const bookId = req.params.bookId;
  
  try {
    await processQueue(bookId);
    res.json({ success: true, message: 'Queue processed successfully' });
  } catch (error) {
    console.error('Manual queue process error:', error);
    res.status(500).json({ error: 'Failed to process queue' });
  }
});
// Rent book endpoint with queue priority
app.post('/api/books/rent', authenticateToken, async (req, res) => {
  const { bookId } = req.body;
  const userId = req.user.id;

  console.log('Rent request - User:', userId, 'Book:', bookId);

  try {
    const [books] = await pool.execute('SELECT * FROM books WHERE id = ?', [bookId]);
    if (books.length === 0) {
      return res.status(404).json({ error: 'Book not found' });
    }

    const book = books[0];
    
    // Check if user has an active reservation (book is available for them)
    const [userReservations] = await pool.execute(`
        SELECT * FROM queue 
        WHERE book_id = ? AND user_id = ? AND status = 'available'
    `, [bookId, userId]);

    const hasReservation = userReservations.length > 0;
    
    // If book is available but user doesn't have reservation, check if someone else does
    if (book.available_copies > 0 && !hasReservation) {
      const [activeReservations] = await pool.execute(`
          SELECT * FROM queue 
          WHERE book_id = ? AND status = 'available'
      `, [bookId]);

      // If there are active reservations, book is reserved for those users
      if (activeReservations.length > 0) {
        return res.status(400).json({ 
          error: 'Book is reserved for users in queue',
          reserved: true,
          available: false
        });
      }
    }

    // Allow rental if:
    // 1. Book is available AND user has reservation, OR
    // 2. Book is available AND no one has reservation
    const canRent = book.available_copies > 0 && 
                   (hasReservation || !hasReservation);

    if (!canRent) {
      return res.status(400).json({ 
        error: 'Book not available for rental',
        available: false 
      });
    }

    const [existingRentals] = await pool.execute(
      'SELECT * FROM rentals WHERE book_id = ? AND user_id = ? AND status = "active"',
      [bookId, userId]
    );

    if (existingRentals.length > 0) {
      return res.status(400).json({ error: 'You already have this book rented' });
    }

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 21);

    await pool.execute(
      'INSERT INTO rentals (book_id, user_id, due_date) VALUES (?, ?, ?)',
      [bookId, userId, dueDate]
    );

    await pool.execute(
      'UPDATE books SET available_copies = available_copies - 1 WHERE id = ?',
      [bookId]
    );

    // Remove user from queue (whether waiting or available)
    await pool.execute(
      'DELETE FROM queue WHERE book_id = ? AND user_id = ?',
      [bookId, userId]
    );

    console.log('Rental created successfully for user:', userId, 'book:', bookId);
    
    res.json({
      success: true,
      message: 'Book rented successfully for 21 days',
      dueDate: dueDate.toISOString()
    });
  } catch (error) {
    console.error('Rent book error:', error);
    res.status(500).json({ error: 'Failed to rent book' });
  }
});

// Get detailed queue information
app.get('/api/books/:id/queue-details', authenticateToken, async (req, res) => {
  const bookId = req.params.id;
  const userId = req.user.id;

  try {
    const [queueItems] = await pool.execute(`
        SELECT q.*, u.name, u.email 
        FROM queue q 
        JOIN users u ON q.user_id = u.id 
        WHERE q.book_id = ? 
        ORDER BY q.added_at ASC
    `, [bookId]);

    const userPosition = queueItems.findIndex(item => item.user_id === userId) + 1;
    const userInQueue = queueItems.some(item => item.user_id === userId);
    
    // Calculate time remaining for each position
    const queueWithTimeRemaining = queueItems.map((item, index) => {
      const joinDate = new Date(item.added_at);
      const expiryDate = new Date(joinDate.getTime() + (2 * 24 * 60 * 60 * 1000)); // 2 days
      const now = new Date();
      const timeRemaining = expiryDate - now;
      
      return {
        ...item,
        position: index + 1,
        joinDate: item.added_at,
        expiryDate: expiryDate.toISOString(),
        timeRemaining: Math.max(0, timeRemaining),
        isExpired: timeRemaining <= 0
      };
    });

    res.json({
      queue: queueWithTimeRemaining,
      userPosition: userInQueue ? userPosition : null,
      totalInQueue: queueItems.length,
      userInQueue
    });
  } catch (error) {
    console.error('Queue details error:', error);
    res.status(500).json({ error: 'Failed to get queue details' });
  }
});

// Queue cleanup endpoint (can be called manually or via cron)
app.post('/api/queue/cleanup', async (req, res) => {
  try {
    const cleaned = await cleanupExpiredQueue();
    res.json({ success: true, cleaned });
  } catch (error) {
    console.error('Queue cleanup error:', error);
    res.status(500).json({ error: 'Failed to clean up queue' });
  }
});

// Get queue info for specific book
app.get('/api/books/:id/queue-info', authenticateToken, async (req, res) => {
  const bookId = req.params.id;
  const userId = req.user.id;

  try {
    // Get queue count and user position
    const [queueItems] = await pool.execute(`
        SELECT q.*, u.name 
        FROM queue q 
        JOIN users u ON q.user_id = u.id 
        WHERE q.book_id = ? 
        ORDER BY q.added_at ASC
    `, [bookId]);

    const userPosition = queueItems.findIndex(item => item.user_id === userId) + 1;
    const totalInQueue = queueItems.length;

    // Check if user is in queue
    const [userInQueue] = await pool.execute(
      'SELECT * FROM queue WHERE book_id = ? AND user_id = ?',
      [bookId, userId]
    );

    res.json({
      totalInQueue,
      userPosition: userInQueue.length > 0 ? userPosition : null,
      isInQueue: userInQueue.length > 0,
      queueList: queueItems.slice(0, 5) // Return first 5 in queue
    });
  } catch (error) {
    console.error('Queue info error:', error);
    res.status(500).json({ error: 'Failed to get queue info' });
  }
});

// Start server
async function startServer() {
  await initializeDatabase();
  
  // Clean up expired queue entries on startup
  await cleanupExpiredQueue();
  
  // Set up periodic queue cleanup (every hour)
  setInterval(cleanupExpiredQueue, 60 * 60 * 1000);
  
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT} ✅`);
    console.log(`Visit: http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);