<?php
// =====================================================================
// API/IMAGE-HELPERS.PHP
// Food-image upload helpers used by donations.php. Only defines functions;
// it is not an endpoint (requesting it directly returns 403).
//
// Where things live
//   files : <project>/uploads/food/food_<32 random hex chars>.<jpg|png|webp>
//   MySQL : DonationImage.image_url holds the RELATIVE path
//           "uploads/food/food_....jpg"  (never binary data, never a URL
//           supplied by the browser)
// =====================================================================
if (basename($_SERVER['SCRIPT_FILENAME'] ?? '') === basename(__FILE__)) {
    http_response_code(403);
    exit;
}

const FOOD_IMAGE_MAX_BYTES  = 5 * 1024 * 1024;          // 5 MB
const FOOD_IMAGE_MAX_SIDE   = 8000;                     // pixels, guards against decompression bombs
const FOOD_IMAGE_REL_DIR    = 'uploads/food';
const FOOD_IMAGE_TYPES      = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'];

/* Absolute path of uploads/food (created on first use). */
function food_image_dir() {
    $dir = dirname(__DIR__) . '/' . FOOD_IMAGE_REL_DIR;
    if (!is_dir($dir) && !@mkdir($dir, 0755, true) && !is_dir($dir)) {
        error_log('[food_waste_management] cannot create ' . $dir);
        throw new ApiException('Image storage is not available on the server.', 500);
    }
    if (!is_writable($dir)) {
        error_log('[food_waste_management] not writable: ' . $dir);
        throw new ApiException('Image storage is not available on the server.', 500);
    }
    return $dir;
}

/* ---------------------------------------------------------------------
   Validate an uploaded file ($_FILES['image']). Nothing is written yet.
   Returns null when no file was sent, otherwise ['tmp','ext','mime'].
   Throws ApiException (413 too big, 415 wrong type, 400 broken upload).
   --------------------------------------------------------------------- */
function validate_food_image($file) {
    if ($file === null) {
        // When a request is larger than post_max_size PHP throws away $_POST
        // AND $_FILES completely - detect that and give a useful message.
        $len  = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
        $type = strtolower($_SERVER['CONTENT_TYPE'] ?? '');
        if ($len > 0 && empty($_POST) && empty($_FILES) && strpos($type, 'multipart/form-data') === 0) {
            throw new ApiException('The upload is too large. Images must be 5 MB or smaller.', 413);
        }
        return null;
    }
    if (!is_array($file) || !isset($file['error']) || is_array($file['error'])) {
        throw new ApiException('Invalid image upload.', 400);
    }

    $err = (int) $file['error'];
    if ($err === UPLOAD_ERR_NO_FILE) {
        return null;
    }
    if ($err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE) {
        throw new ApiException('Image must be 5 MB or smaller.', 413);
    }
    if ($err === UPLOAD_ERR_PARTIAL) {
        throw new ApiException('The image upload was interrupted. Please try again.', 400);
    }
    if ($err !== UPLOAD_ERR_OK) {
        error_log('[food_waste_management] upload error code ' . $err);
        throw new ApiException('The server could not receive the image.', 500);
    }

    $tmp = $file['tmp_name'] ?? '';
    if (!is_string($tmp) || $tmp === '' || !is_uploaded_file($tmp)) {
        throw new ApiException('Invalid image upload.', 400);
    }

    // Measure the real temp file - never trust the size the browser reports.
    $size = filesize($tmp);
    if ($size === false || $size <= 0) {
        throw new ApiException('The image file is empty.', 400);
    }
    if ($size > FOOD_IMAGE_MAX_BYTES) {
        throw new ApiException('Image must be 5 MB or smaller.', 413);
    }

    // Real MIME type from the file's contents (not the file name / browser type).
    if (!class_exists('finfo')) {
        error_log('[food_waste_management] PHP fileinfo extension is not enabled');
        throw new ApiException('Image validation is not available on the server (enable the fileinfo extension in php.ini).', 500);
    }
    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $mime  = $finfo->file($tmp);
    if (!is_string($mime) || !isset(FOOD_IMAGE_TYPES[$mime])) {
        throw new ApiException('Only JPEG, PNG and WebP images are allowed.', 415);
    }

    // Second opinion: it must also parse as an image of that same type.
    $info = @getimagesize($tmp);
    if ($info === false || ($info['mime'] ?? '') !== $mime) {
        throw new ApiException('That file is not a valid image.', 415);
    }
    if ($info[0] > FOOD_IMAGE_MAX_SIDE || $info[1] > FOOD_IMAGE_MAX_SIDE) {
        throw new ApiException('Image dimensions are too large (maximum ' . FOOD_IMAGE_MAX_SIDE . ' x ' . FOOD_IMAGE_MAX_SIDE . ' pixels).', 400);
    }

    return ['tmp' => $tmp, 'ext' => FOOD_IMAGE_TYPES[$mime], 'mime' => $mime];
}

/* ---------------------------------------------------------------------
   Move a validated upload into uploads/food/ under a random name.
   The extension comes from the detected MIME type, never from the
   uploaded file name. Returns ['abs' => full path, 'path' => relative path].
   --------------------------------------------------------------------- */
function store_food_image(array $valid) {
    $dir = food_image_dir();

    $name = null;
    $abs  = null;
    for ($i = 0; $i < 5; $i++) {
        $candidate = 'food_' . bin2hex(random_bytes(16)) . '.' . $valid['ext'];
        if (!file_exists($dir . '/' . $candidate)) {
            $name = $candidate;
            $abs  = $dir . '/' . $candidate;
            break;
        }
    }
    if ($name === null) {
        throw new ApiException('The image could not be saved on the server.', 500);
    }

    if (!move_uploaded_file($valid['tmp'], $abs)) {
        error_log('[food_waste_management] move_uploaded_file failed for ' . $abs);
        throw new ApiException('The image could not be saved on the server.', 500);
    }
    @chmod($abs, 0644);

    return ['abs' => $abs, 'path' => FOOD_IMAGE_REL_DIR . '/' . $name];
}

/* Remove a file we just stored (used to clean up when the database step fails). */
function discard_food_image_file($abs) {
    if (is_string($abs) && $abs !== '' && is_file($abs)) {
        @unlink($abs);
    }
}

/* ---------------------------------------------------------------------
   Delete a stored image by the relative path read from DonationImage.
   Refuses anything that is not exactly uploads/food/food_<32 hex>.<ext>,
   anything that is a symlink, and anything that resolves outside
   uploads/food/. Callers must only pass paths that came from the row(s) of
   the donation being changed.
   --------------------------------------------------------------------- */
function delete_food_image_by_path($rel) {
    if (!is_string($rel) || !preg_match('#^uploads/food/(food_[a-f0-9]{32}\.(?:jpg|png|webp))$#D', $rel, $m)) {
        return false;
    }
    $dir = realpath(dirname(__DIR__) . '/' . FOOD_IMAGE_REL_DIR);
    if ($dir === false) {
        return false;
    }
    $abs = $dir . DIRECTORY_SEPARATOR . $m[1];
    if (is_link($abs)) {
        return false;
    }
    $real = realpath($abs);
    if ($real === false || dirname($real) !== $dir || !is_file($real)) {
        return false;
    }
    return @unlink($real);
}
