const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  userName: { type: String, required: true },
  rating: { type: Number, required: true, min: 1, max: 5 },
  comment: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const productSchema = new mongoose.Schema({
  customId: { type: String, required: true, unique: true }, // Jaise: PROD-101
  title: { type: String, required: true },
  price: { type: Number, required: true },
  originalPrice: { type: Number }, // Lowest price strike-through ke liye
  category: { type: String, enum: ['men', 'women', 'kids'], required: true },
  images: [{ type: String, required: true }], // Multiple photos
  sizes: [{ type: String }], // e.g. ['S', 'M', 'L', 'XL']
  description: String,
  reviews: [reviewSchema],
  avgRating: { type: Number, default: 0 }
});

module.exports = mongoose.model('Product', productSchema);