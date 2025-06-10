const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cloudinary = require('cloudinary').v2;
const Mailchimp = require('@mailchimp/mailchimp_marketing');
const dotenv = require('dotenv');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increased limit for larger files
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('public/uploads')); // Serve uploaded files

// Suppress Mongoose strictQuery warning
mongoose.set('strictQuery', true);

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// Cloudinary Configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Mailchimp Configuration
Mailchimp.setConfig({
  apiKey: process.env.MAILCHIMP_API_KEY,
  server: process.env.MAILCHIMP_SERVER_PREFIX,
});

// Multer Configuration for File Uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = 'public/uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB limit

// Models
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
});
const User = mongoose.model('User', UserSchema);

const CourseSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String },
  fileUrl: { type: String },
  createdAt: { type: Date, default: Date.now },
});
const Course = mongoose.model('Course', CourseSchema);

const EmailSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  subscribedAt: { type: Date, default: Date.now },
});
const Email = mongoose.model('Email', EmailSchema);

// Middleware for Authentication
const authMiddleware = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Access denied' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Routes

// Public Courses (no authentication required)
app.get('/api/public-courses', async (req, res) => {
  try {
    const courses = await Course.find({}, 'title description fileUrl'); // Only return public fields
    res.json(courses);
  } catch (error) {
    console.error('Error fetching public courses:', error.message);
    res.status(500).json({ error: 'Failed to fetch public courses' });
  }
});

// Client Signup
app.post('/api/signup', async (req, res) => {
  const { email, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ email, password: hashedPassword });
    await user.save();
    res.status(201).json({ message: 'User created' });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    res.status(400).json({ error: 'Signup failed' });
  }
});

// Client Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Add Course with File Upload
app.post('/api/courses', authMiddleware, upload.single('file'), async (req, res) => {
  const { title, description } = req.body;
  const file = req.file;
  try {
    console.log('Adding course:', { title, description, file });
    let fileUrl;
    if (file) {
      const uploadResult = await cloudinary.uploader.upload(file.path, {
        resource_type: 'video', // Explicitly set for video uploads
        folder: 'jade_fx_courses',
        timestamp: Math.floor(Date.now() / 1000),
      });
      fileUrl = uploadResult.secure_url;
      fs.unlinkSync(file.path); // Clean up temp file
    } else if (req.body.fileUrl) {
      fileUrl = req.body.fileUrl;
    } else {
      throw new Error('No file or URL provided');
    }
    const course = new Course({ title, description, fileUrl });
    await course.save();
    console.log('Course saved:', course);
    res.status(201).json(course);
  } catch (error) {
    console.error('Error adding course:', error.message);
    if (file) fs.unlinkSync(file.path); // Clean up on error
    res.status(500).json({ error: error.message || 'Failed to add course' });
  }
});

// Get All Courses
app.get('/api/courses', authMiddleware, async (req, res) => {
  try {
    console.log('Received GET request to /api/courses');
    const courses = await Course.find();
    console.log('Courses fetched:', courses);
    if (!courses || courses.length === 0) {
      console.log('No courses found in database');
    }
    res.json(courses);
  } catch (error) {
    console.error('Error fetching courses:', error.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Specific Course
app.get('/api/courses/:id', authMiddleware, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) throw new Error('Course not found');
    res.json(course);
  } catch (error) {
    console.error('Error fetching course:', error.message);
    res.status(500).json({ error: error.message || 'Failed to fetch course' });
  }
});

// Delete Course
app.delete('/api/courses/:id', authMiddleware, async (req, res) => {
  try {
    const course = await Course.findByIdAndDelete(req.params.id);
    if (!course) throw new Error('Course not found');
    res.json({ message: 'Course deleted successfully' });
  } catch (error) {
    console.error('Error deleting course:', error.message);
    res.status(500).json({ error: error.message || 'Failed to delete course' });
  }
});

// Get All Subscribers
app.get('/api/subscribers', authMiddleware, async (req, res) => {
  try {
    console.log('Received GET request to /api/subscribers');
    const subscribers = await Email.find({}, 'email');
    console.log('Subscribers fetched:', subscribers);
    if (!subscribers || subscribers.length === 0) {
      console.log('No subscribers found in database');
    }
    res.json(subscribers);
  } catch (error) {
    console.error('Error fetching subscribers:', error.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Subscriber Count
app.get('/api/subscribers/count', authMiddleware, async (req, res) => {
  try {
    const count = await Email.countDocuments();
    res.json({ count });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Send Email to All Subscribers
app.post('/api/send-email', authMiddleware, async (req, res) => {
  const { subject, message } = req.body;
  try {
    const subscribers = await Email.find({}, 'email');
    const emails = subscribers.map(sub => sub.email);

    const response = await Mailchimp.campaigns.create({
      type: 'regular',
      recipients: {
        list_id: process.env.MAILCHIMP_AUDIENCE_ID,
        segment_opts: { saved_segment_id: null, match: 'all' },
      },
      settings: {
        subject: subject,
        from_name: 'JadeFX',
        reply_to: 'no-reply@jadefx.com',
        to_name: 'Subscriber',
      },
      content: {
        html: message,
      },
    });

    await Mailchimp.campaigns.send(response.id);
    res.json({ message: 'Emails sent successfully' });
  } catch (error) {
    console.error('Error sending email:', error.message);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// Capture Email and Add to Mailchimp
app.post('/api/emails', async (req, res) => {
  const { email } = req.body;
  console.log('Received POST request to /api/emails:', email);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.log('Invalid email format:', email);
    return res.status(400).json({ error: 'Invalid email' });
  }

  try {
    const existingEmail = await Email.findOne({ email });
    if (existingEmail) {
      console.log('Duplicate email detected:', email);
      return res.status(409).json({ error: 'Email already exists' });
    }

    const newEmail = new Email({ email });
    await newEmail.save();
    console.log('Email saved to MongoDB:', email);

    const response = await Mailchimp.lists.addListMember(process.env.MAILCHIMP_AUDIENCE_ID, {
      email_address: email,
      status: 'subscribed',
    });

    console.log('Mailchimp response:', response.id);
    res.status(201).json({ message: 'Email captured successfully' });
  } catch (error) {
    console.error('Error capturing email:', error.message);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start Server with Port Fallback
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));