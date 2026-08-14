var multer = require('multer')
const fs = require('fs')
const path = require('path')
const { v4: uuidv4 } = require('uuid');

const filesDir = path.join(__dirname, '..', 'public', 'files')
if (!fs.existsSync(filesDir)) {
  fs.mkdirSync(filesDir, { recursive: true })
}

var storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, filesDir)
    },
    filename: (req, file, cb) => {
        const original = file.originalname || 'upload.bin'
        const ext = path.extname(original) || '.webm'
        cb(null, uuidv4() + ext)
    }
});
var upload = multer({ storage: storage, limits: { fileSize: 80 * 1024 * 1024 } })
module.exports = upload;
