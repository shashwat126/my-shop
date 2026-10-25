const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const Product = require('./models/Product');
const Order = require('./models/Order');
const User = require('./models/User');

const app = express();

app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');

// Session setup
app.use(session({
  secret: 'mysecretstored12345',
  resave: false,
  saveUninitialized: false
}));

// Global Middleware for Current User & Cart Count
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  const cart = req.session.cart || { items: [] };
  res.locals.cartCount = cart.items.reduce((sum, item) => sum + item.quantity, 0);
  next();
});

// Admin Protection Middleware
const isAdmin = (req, res, next) => {
  if (req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  return res.status(403).send('<h2 style="font-family:sans-serif; text-align:center; margin-top:50px; color:red;">Access Denied! Sirf Admin is page ko access kar sakta hai. <br><br><a href="/">Store par wapis jayein</a></h2>');
};

// MongoDB Connection
mongoose.connect('mongodb+srv://shashwat126:ShopStore12345@cluster0.f995iqs.mongodb.net/myshop?retryWrites=true&w=majority')
  .then(() => console.log('MongoDB Database Connect Ho Gaya!'))
  .catch((err) => console.log('Database connection error:', err));

// 1. Home Page with Category Filter
app.get('/', async (req, res) => {
  try {
    const selectedCategory = req.query.category;
    let filter = {};
    if (selectedCategory && ['men', 'women', 'kids'].includes(selectedCategory)) {
      filter.category = selectedCategory;
    }
    const products = await Product.find(filter);
    res.render('index', { products, currentCategory: selectedCategory || 'all' });
  } catch (err) {
    res.render('index', { products: [], currentCategory: 'all' });
  }
});

// 2. Product Detail Page
app.get('/product/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.redirect('/');
    res.render('product-detail', { product });
  } catch (err) {
    res.redirect('/');
  }
});

// 3. Customer Reviews Route
app.post('/product/:id/review', async (req, res) => {
  try {
    const { userName, rating, comment } = req.body;
    const product = await Product.findById(req.params.id);
    
    product.reviews.push({ userName, rating: Number(rating), comment });
    
    const totalRating = product.reviews.reduce((sum, r) => sum + r.rating, 0);
    product.avgRating = totalRating / product.reviews.length;
    
    await product.save();
    res.redirect(`/product/${req.params.id}`);
  } catch (err) {
    res.redirect(`/product/${req.params.id}`);
  }
});

// 4. Admin: Add Product (Protected)
app.get('/admin/add-product', isAdmin, (req, res) => {
  res.render('add-product');
});

app.post('/admin/add-product', isAdmin, async (req, res) => {
  try {
    const { customId, title, price, originalPrice, category, images, sizes, description } = req.body;
    
    const imageList = images ? images.split(',').map(s => s.trim()).filter(Boolean) : [];
    const sizeList = sizes ? sizes.split(',').map(s => s.trim()).filter(Boolean) : [];

    await Product.create({
      customId,
      title,
      price,
      originalPrice,
      category,
      images: imageList,
      sizes: sizeList,
      description
    });
    res.redirect('/');
  } catch (err) {
    res.send('Product save karne me dikkat: ' + err.message);
  }
});

// 5. Admin: Edit Product (Protected)
app.get('/admin/edit-product/:id', isAdmin, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.redirect('/');
    res.render('edit-product', { product });
  } catch (err) {
    res.redirect('/');
  }
});

app.post('/admin/edit-product/:id', isAdmin, async (req, res) => {
  try {
    const { customId, title, price, originalPrice, category, images, sizes, description } = req.body;
    const imageList = images ? images.split(',').map(s => s.trim()).filter(Boolean) : [];
    const sizeList = sizes ? sizes.split(',').map(s => s.trim()).filter(Boolean) : [];

    await Product.findByIdAndUpdate(req.params.id, {
      customId,
      title,
      price,
      originalPrice,
      category,
      images: imageList,
      sizes: sizeList,
      description
    });
    res.redirect('/');
  } catch (err) {
    res.send('Product update karne me problem: ' + err.message);
  }
});

// 6. Admin: Delete Product (Protected)
app.get('/admin/delete-product/:id', isAdmin, async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.redirect('/');
  } catch (err) {
    res.send('Product delete karne me samasya aayi.');
  }
});

// 7. Admin: View Orders (Protected)
app.get('/admin/orders', isAdmin, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.render('orders', { orders });
  } catch (err) {
    res.render('orders', { orders: [] });
  }
});

// 8. Cart Routes
app.post('/cart/add', async (req, res) => {
  const { productId, selectedSize } = req.body;
  const product = await Product.findById(productId);

  if (!req.session.cart) {
    req.session.cart = { items: [], totalPrice: 0 };
  }

  const cart = req.session.cart;
  const itemImg = (product.images && product.images.length > 0) ? product.images[0] : (product.imageUrl || '');

  const itemIndex = cart.items.findIndex(p => p.productId === productId && p.size === selectedSize);

  if (itemIndex > -1) {
    cart.items[itemIndex].quantity += 1;
  } else {
    cart.items.push({
      productId: product._id.toString(),
      customId: product.customId,
      title: product.title,
      price: product.price,
      imageUrl: itemImg,
      size: selectedSize || 'Standard',
      quantity: 1
    });
  }

  cart.totalPrice = cart.items.reduce((total, item) => total + (item.price * item.quantity), 0);
  res.redirect('/cart');
});

app.get('/cart', (req, res) => {
  res.render('cart', { cart: req.session.cart || { items: [], totalPrice: 0 } });
});

app.get('/cart/remove/:id', (req, res) => {
  if (req.session.cart) {
    req.session.cart.items = req.session.cart.items.filter(item => item.productId !== req.params.id);
    req.session.cart.totalPrice = req.session.cart.items.reduce((total, item) => total + (item.price * item.quantity), 0);
  }
  res.redirect('/cart');
});

// 9. Checkout & Order Placement
app.get('/checkout', (req, res) => {
  if (!req.session.cart || req.session.cart.items.length === 0) {
    return res.redirect('/cart');
  }
  res.render('checkout', { cart: req.session.cart });
});

app.post('/place-order', async (req, res) => {
  try {
    const { customerName, phone, address } = req.body;
    const cart = req.session.cart;
    if (!cart || cart.items.length === 0) return res.redirect('/');

    await Order.create({
      items: cart.items.map(i => ({ title: i.title, price: i.price, quantity: i.quantity })),
      totalAmount: cart.totalPrice,
      customerName,
      phone,
      address
    });

    req.session.cart = null;
    res.send(`
      <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
        <h1 style="color: green;">🎉 Order Successfully Placed!</h1>
        <p>Aapka order confirm ho gaya hai.</p>
        <a href="/" style="color: #2563eb; text-decoration: none; font-weight: bold;">Continue Shopping</a>
      </div>
    `);
  } catch (err) {
    res.send('Order place karne me samasya aayi.');
  }
});

// 10. Auth Routes
app.get('/signup', (req, res) => res.render('signup', { error: null }));
app.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.render('signup', { error: 'Ye email pehle se registered hai.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hashedPassword });
    req.session.user = user;
    res.redirect('/');
  } catch (err) {
    res.render('signup', { error: 'Account banane me samasya aayi.' });
  }
});

app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.render('login', { error: 'Email ya password galat hai.' });
    }
    req.session.user = user;
    res.redirect('/');
  } catch (err) {
    res.render('login', { error: 'Login me dikkat aayi.' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server live hai: http://localhost:${PORT}`);
});