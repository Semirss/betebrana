import sys
import os
import re
import time
from pdf2image import convert_from_path, pdfinfo_from_path
import pytesseract
from PIL import Image, ImageFilter, ImageEnhance, ImageOps

# =================================================================
# CRITICAL POPPLER CONFIGURATION - SET YOUR ACTUAL PATH HERE
# =================================================================
POPPLER_PATH = r"C:\Users\yonatan\Downloads\Documents\poppler\Library\bin"

# =================================================================
# TESSERACT CONFIGURATION (Set if not in PATH)
# =================================================================
TESSERACT_CMD = (
    r"C:\Program Files\Tesseract-OCR\tesseract.exe"  # Uncomment and set if needed
)
if TESSERACT_CMD and os.path.exists(TESSERACT_CMD):
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD

# Verify Poppler installation
if not os.path.exists(POPPLER_PATH):
    print(f"CRITICAL ERROR: Poppler path not found at '{POPPLER_PATH}'")
    print(
        "Please download Poppler from: https://github.com/oschwartz10612/poppler-windows/releases/"
    )
    print("Extract it and set the POPPLER_PATH variable in this script")
    sys.exit(1)

# Check for required Poppler binaries
required_binaries = ["pdftoppm.exe", "pdfinfo.exe"]
for binary in required_binaries:
    bin_path = os.path.join(POPPLER_PATH, binary)
    if not os.path.exists(bin_path):
        print(f"CRITICAL ERROR: Missing Poppler binary: {bin_path}")
        print("Please ensure you have the complete Poppler installation")
        sys.exit(1)

# --- Try to import tqdm for progress bars ---
try:
    from tqdm import tqdm

    HAS_TQDM = True
except ImportError:
    HAS_TQDM = False


def validate_language(lang="amh"):
    """Check if Amharic language is supported by Tesseract"""
    try:
        available_langs = pytesseract.get_languages(config="")
        if lang not in available_langs:
            print(
                f"Error: Amharic language not installed. Available languages: {', '.join(available_langs)}"
            )
            print("Install Amharic language data for Tesseract:")
            print(
                "  - Windows: Download 'amh.traineddata' from https://github.com/tesseract-ocr/tessdata"
            )
            print("             Place in Tesseract's 'tessdata' directory")
            print("  - Linux:   sudo apt-get install tesseract-ocr-amh")
            print("  - Mac:     brew install tesseract-lang")
            return False
        return True
    except pytesseract.TesseractNotFoundError:
        print("Error: Tesseract is not installed or not in your PATH.")
        print("Please install Tesseract OCR and ensure it's accessible.")
        return False
    except Exception as e:
        print(f"Error checking languages: {e}")
        return False


def preprocess_image_for_amharic(image):
    """Enhance image quality specifically for Amharic script recognition"""
    # Convert to grayscale
    img = image.convert("L")

    # Increase contrast
    enhancer = ImageEnhance.Contrast(img)
    img = enhancer.enhance(1.5)

    # Sharpen image
    enhancer = ImageEnhance.Sharpness(img)
    img = enhancer.enhance(1.2)

    # Apply adaptive thresholding
    img = ImageOps.autocontrast(img, cutoff=2)

    # Reduce noise while preserving edges
    img = img.filter(ImageFilter.MedianFilter(size=1))

    return img


def get_unique_filename(directory, base_name, extension):
    """Generate a unique filename to prevent overwriting"""
    counter = 1
    while True:
        if counter == 1:
            filename = f"{base_name}_converted{extension}"
        else:
            filename = f"{base_name}_converted_{counter}{extension}"

        full_path = os.path.join(directory, filename)
        if not os.path.exists(full_path):
            return full_path
        counter += 1


def pdf_to_text_ocr(pdf_path, output_folder=None, dpi=300, progress_bar=True):
    """
    Converts a scanned Amharic PDF book to plain text using OCR

    Args:
        pdf_path (str): Path to input PDF file
        output_folder (str, optional): Output directory for text file
        dpi (int, optional): DPI for image conversion. Defaults to 300.
        progress_bar (bool, optional): Show progress bar. Defaults to True.

    Returns:
        str: Path to generated text file, or None on error
    """
    # Validate input
    if not os.path.exists(pdf_path):
        print(f"Error: File not found - '{pdf_path}'")
        return None
    if not os.path.isfile(pdf_path):
        print(f"Error: Path is not a file - '{pdf_path}'")
        return None
    if not pdf_path.lower().endswith(".pdf"):
        print(f"Error: Not a PDF file - '{pdf_path}'")
        return None
    if not validate_language("amh"):
        return None

    try:
        # Create output directory if needed
        if output_folder:
            os.makedirs(output_folder, exist_ok=True)
            output_dir = output_folder
        else:
            output_dir = os.path.dirname(pdf_path) or "."

        # Generate unique output filename
        base_name = os.path.splitext(os.path.basename(pdf_path))[0]
        output_path = get_unique_filename(output_dir, base_name, ".txt")

        # Get PDF info first
        print(f"Getting PDF information for: '{pdf_path}'")
        try:
            info = pdfinfo_from_path(pdf_path, poppler_path=POPPLER_PATH)
            total_pages = info["Pages"]
            print(f"  Found {total_pages} pages")
        except Exception as e:
            print(f"Error getting PDF info: {e}")
            # Try alternative method to get page count
            try:
                images = convert_from_path(pdf_path, dpi=50, poppler_path=POPPLER_PATH)
                total_pages = len(images)
                print(f"  Estimated page count: {total_pages} (via image conversion)")
            except:
                print("Could not determine page count, aborting")
                return None

        # Custom Tesseract configuration optimized for Amharic books
        tesseract_config = (
            "--psm 6 "  # Assume uniform block of text
            "-c preserve_interword_spaces=1 "  # Important for Amharic spacing
            "--oem 1"  # LSTM OCR engine
        )

        # Prepare progress indicator
        use_progress_bar = progress_bar and HAS_TQDM and total_pages > 3
        if use_progress_bar:
            pbar = tqdm(total=total_pages, desc="OCR Processing", unit="page")

        # Process pages one by one
        print(f"Starting conversion (DPI: {dpi})...")
        start_time = time.time()

        with open(output_path, "w", encoding="utf-8") as output_file:
            for page_num in range(1, total_pages + 1):
                page_start = time.time()

                # Show progress
                if not use_progress_bar:
                    print(
                        f"  Processing page {page_num}/{total_pages}...",
                        end="",
                        flush=True,
                    )

                try:
                    # Convert single page to image
                    images = convert_from_path(
                        pdf_path,
                        dpi=dpi,
                        first_page=page_num,
                        last_page=page_num,
                        poppler_path=POPPLER_PATH,
                        thread_count=1,  # Single-threaded for reliability
                    )

                    if not images:
                        output_file.write(
                            f"\n\n[ PAGE {page_num} CONVERSION FAILED ]\n\n"
                        )
                        if not use_progress_bar:
                            print(" conversion failed!")
                        continue

                    # Preprocess image for Amharic
                    processed_img = preprocess_image_for_amharic(images[0])

                    # Perform OCR
                    text = pytesseract.image_to_string(
                        processed_img, lang="amh", config=tesseract_config
                    )

                    # Post-processing for Amharic text
                    text = re.sub(
                        r"(\S)-\s+(\S)", r"\1\2", text
                    )  # Fix hyphenated words
                    text = re.sub(
                        r"([\u1200-\u137F])\s+([\u1200-\u137F])", r"\1\2", text
                    )  # Fix space between Amharic chars

                    output_file.write(text)
                    output_file.write("\n\n")  # Page separator

                    # Clean up memory
                    del images, processed_img

                    if not use_progress_bar:
                        page_time = time.time() - page_start
                        print(f" done in {page_time:.1f}s")

                except Exception as e:
                    print(f"\nError processing page {page_num}: {str(e)}")
                    output_file.write(
                        f"\n\n[ PAGE {page_num} PROCESSING ERROR: {str(e)} ]\n\n"
                    )

                if use_progress_bar:
                    pbar.update(1)

        if use_progress_bar:
            pbar.close()

        total_time = time.time() - start_time
        print(f"Successfully created: '{output_path}'")
        print(f"Total processing time: {total_time:.1f} seconds")
        return output_path

    except Exception as e:
        print(f"Critical error processing '{pdf_path}': {str(e)}")
        if "PDF" in str(e) and "encrypted" in str(e):
            print("Tip: The PDF might be password-protected. Use a decrypted version.")
        return None


def convert_directory(input_dir, output_dir=None):
    """
    Convert all PDF files in a directory (including subdirectories) to text

    Args:
        input_dir (str): Path to directory containing PDF files
        output_dir (str, optional): Output root directory for text files
    """
    if not os.path.isdir(input_dir):
        print(f"Error: Input path is not a directory - '{input_dir}'")
        return

    print(f"Starting conversion of all PDFs in: {input_dir}")
    total_files = 0
    converted_files = 0

    # Walk through all directories and subdirectories
    for root, dirs, files in os.walk(input_dir):
        for file in files:
            if file.lower().endswith(".pdf"):
                total_files += 1
                pdf_path = os.path.join(root, file)

                # Determine output directory structure
                if output_dir:
                    # Preserve relative path structure
                    rel_path = os.path.relpath(root, input_dir)
                    out_folder = os.path.join(output_dir, rel_path)
                else:
                    out_folder = root

                print(f"\nProcessing ({total_files}): {pdf_path}")
                result = pdf_to_text_ocr(pdf_path, out_folder)
                if result:
                    converted_files += 1

    print(f"\nConversion complete!")
    print(f"Total PDF files found: {total_files}")
    print(f"Successfully converted: {converted_files}")
    if total_files > converted_files:
        print(f"Failed to convert: {total_files - converted_files} files")


if __name__ == "__main__":
    # =================================================================
    # CONFIGURATION: Set your input and output paths here
    # =================================================================
    input_directory = r"C:\Users\yonatan\OneDrive\Desktop\TERAKI\PDF files"
    output_directory = r"C:\Users\yonatan\OneDrive\Desktop\TERAKI\txt files"

    # Create output directory if it doesn't exist
    os.makedirs(output_directory, exist_ok=True)

    # =================================================================
    # PROCESSING: Choose one of these options
    # =================================================================

    # Option 1: Process a directory
    convert_directory(input_directory, output_directory)

    # Option 2: Process a single file (uncomment and modify)
    # pdf_path = os.path.join(input_directory, "specific_file.pdf")
    # pdf_to_text_ocr(pdf_path, output_directory)
