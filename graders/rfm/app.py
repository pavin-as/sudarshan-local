"""RFM grader (D-044): the RFM retinal foundation model with its released DR classification heads, as a second research
grader beside Arko007. Same contract as the Arko007 grader: GET /health, POST /api/grade (image body, x-grader-key).

No RFM repository code runs here. The model is rebuilt from the published method (ok1zjf/RFM @ b8c9322, model.py,
dataset.py, dataset_prep_common.py; MIT, Jiri Fajtl 2026) on stock timm:
  image -> RGB -> dataset preparation (short side 512, Lanczos; centre square crop for the APTOS/IDRiD heads; JPEG q95
  round trip) -> resize 336 bicubic -> centre crop 336 -> normalise (RFM fundus statistics)
  -> ViT-B/16 DINOv3 (timm vit_base_patch16_dinov3.lvd1689m, RFM weights, blocks 0-8)
  -> features = [CLS token, mean of patch tokens] of block 8 (1536) -> LayerNorm -> Linear(5) -> softmax.

Safety: every weights file must match its pinned SHA-256 and its pickle may import only tensor-rebuild functions,
storages and OrderedDict (checked by parsing the opcodes, nothing executed) before torch.load(weights_only=True).
The photograph is held in memory only. Logs carry image hashes, never patient details.
Weights: RFM backbone under the DINOv3 License ("Built with DINOv3"); heads: no licence stated (research use only).
"""
import hashlib
import hmac
import io
import logging
import os
import pickletools
import threading
import time
import zipfile
from urllib.parse import unquote

import timm
import torch
import torch.nn as nn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from PIL import Image, UnidentifiedImageError
from torchvision import transforms

APP_VERSION = "1.0.0"
REPO, COMMIT = "ok1zjf/RFM", "b8c9322"
WEIGHTS = os.environ.get("RFM_WEIGHTS", "/weights")
KEY = os.environ.get("GRADER_API_KEY", "")
DEFAULT_HEAD = os.environ.get("RFM_HEAD", "aptos")
MAX_MB = 40
PINS = {   # SHA-256 recorded on 25 Oct 2026 from the official download (backbone) and the repo at b8c9322 (heads)
    "rfm-1.3.pt": "fdb51814aeea26463c39b1cd254e473eb6005f52abb1dff92bb83010039bf2f3",
    "heads/aptos.pt": "3e913fbf2f6461b3929bad117ace9144380f9ab20df59e7491775c20addaa2a5",
    "heads/messidor.pt": "950279eff60abedd5b043cf9577b1043a14c4771ffbdbae3aabd4e642e06fc36",
    "heads/idrid.pt": "5fa29ab999cd4dd4bdd5c1a4527dac345ec878f52a6e8fa012ebdb01566c7191",
}
PREP = {"aptos": "crop", "idrid": "crop", "messidor": None}     # dataset_prep_common.RESIZE_PARAMS of each head's data
MEAN, STD = (0.4271227, 0.24723781, 0.13661437), (0.26101578, 0.16189588, 0.09271526)
IMG_SIZE, FORWARD_LAYER, TIMM_NAME = 336, 8, "vit_base_patch16_dinov3.lvd1689m"
ALLOWED_IMPORTS = {"collections.OrderedDict", "torch.FloatStorage", "torch._utils._rebuild_tensor_v2"}

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)-7s | %(message)s")
log = logging.getLogger("rfm")
torch.set_num_threads(int(os.environ.get("TORCH_THREADS", "8")))
STATE = {"loaded": False, "error": None, "heads": {}, "load_seconds": None}
_lock = threading.Lock()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def pickle_imports(path):
    """Every global the checkpoint's pickle would import, read from its opcodes (nothing is executed)."""
    with zipfile.ZipFile(path) as z:
        pkl = [n for n in z.namelist() if n.endswith("data.pkl")]
        if len(pkl) != 1:
            raise RuntimeError(f"{path}: expected one data.pkl, found {len(pkl)}")
        data = z.read(pkl[0])
    found, recent = set(), []
    for op, arg, _ in pickletools.genops(data):
        if op.name in ("SHORT_BINUNICODE", "BINUNICODE", "UNICODE", "BINUNICODE8"):
            recent = (recent + [arg])[-2:]
        elif op.name == "GLOBAL":
            found.add(arg.replace(" ", "."))
        elif op.name == "STACK_GLOBAL":
            found.add(".".join(recent))
        elif op.name in ("INST", "OBJ", "NEWOBJ", "NEWOBJ_EX"):
            found.add(f"<{op.name}>")
    return found


def safe_load(rel):
    path = os.path.join(WEIGHTS, rel)
    digest = sha256_file(path)
    if digest != PINS[rel]:
        raise RuntimeError(f"{rel}: SHA-256 {digest} does not match the pinned {PINS[rel]}; refusing to load")
    extra = pickle_imports(path) - ALLOWED_IMPORTS
    if extra:
        raise RuntimeError(f"{rel}: pickle imports {sorted(extra)} outside the tensor-only allowlist; refusing to load")
    log.info("GUARD | %s: SHA-256 pinned, pickle tensor-only: loading with weights_only=True", rel)
    return torch.load(path, map_location="cpu", weights_only=True), digest


def build():
    t0 = time.time()
    ckpt, bb_sha = safe_load("rfm-1.3.pt")
    backbone = timm.create_model(TIMM_NAME, pretrained=False, num_classes=0, img_size=IMG_SIZE, drop_path_rate=0.0, global_pool="token")
    sd = {k[len("backbone."):]: v for k, v in ckpt["model_state_dict"].items() if k.startswith("backbone.")}
    res = backbone.load_state_dict(sd, strict=False)
    missing = {".".join(k.split(".")[:2]) for k in res.missing_keys}
    if res.unexpected_keys or not missing <= {"blocks.9", "blocks.10", "blocks.11", "norm.weight", "norm.bias"}:
        raise RuntimeError(f"backbone mismatch: missing {sorted(missing)}, unexpected {res.unexpected_keys[:5]}")
    backbone.eval()
    heads = {}
    for name in PREP:
        hc, h_sha = safe_load(f"heads/{name}.pt")
        # The released RFM heads record model_name "dinov3": in RFM's model.py "dinov3" and "rfm" share identical
        # MODEL_DEFAULTS (architecture, normalisation, head LayerNorm, block-8 CLS+mean features); what makes it an RFM
        # head is the backbone it was trained on, which must be rfm-1.3.pt.
        if hc.get("model_name") not in ("rfm", "dinov3") or hc.get("backbone_file") != "rfm-1.3.pt":
            raise RuntimeError(f"head {name}: made for {hc.get('model_name')}/{hc.get('backbone_file')}, not an RFM head on rfm-1.3.pt")
        head = nn.Sequential(nn.LayerNorm(2 * backbone.embed_dim), nn.Linear(2 * backbone.embed_dim, 5))
        head.load_state_dict({k[len("net."):]: v for k, v in hc["head"].items()})
        head.eval()
        heads[name] = {"module": head, "sha": h_sha, "model_sha256": hashlib.sha256(f"{bb_sha}:{h_sha}".encode()).hexdigest(),
                       "epoch": int(hc.get("epoch", -1)), "val_score": float(hc.get("score", float("nan")))}
    STATE.update(backbone=backbone, backbone_sha=bb_sha, heads=heads, loaded=True, load_seconds=round(time.time() - t0, 1))
    log.info("STARTUP | RFM loaded in %.1fs: heads %s", STATE["load_seconds"], ", ".join(f"{k} (epoch {v['epoch']})" for k, v in heads.items()))


def resize_image(img, short_side, square):
    """dataset_prep_common.resize_image (RFM, MIT): Lanczos to short side; 'crop' = centre square crop."""
    w, h = img.size
    if square == "crop":
        scale = short_side / min(w, h)
        rw, rh = max(1, round(w * scale)), max(1, round(h * scale))
        img = img.resize((rw, rh), Image.LANCZOS)
        left, top = (rw - short_side) // 2, (rh - short_side) // 2
        return img.crop((left, top, left + short_side, top + short_side))
    if h < w:
        new_h, new_w = short_side, round(w * short_side / h)
    else:
        new_w, new_h = short_side, round(h * short_side / w)
    return img.resize((new_w, new_h), Image.LANCZOS)


TEST_TRANSFORM = transforms.Compose([
    transforms.Resize(IMG_SIZE, interpolation=transforms.InterpolationMode.BICUBIC),
    transforms.CenterCrop(IMG_SIZE), transforms.ToTensor(), transforms.Normalize(mean=MEAN, std=STD)])


class ImageError(ValueError):
    pass


def open_image(raw, filename):
    if not raw:
        raise ImageError("The file is empty (0 bytes).")
    if len(raw) > MAX_MB * 1048576:
        raise ImageError(f"File is {len(raw) / 1048576:.1f} MB — the limit is {MAX_MB} MB.")
    if os.path.splitext(filename or "")[1].lower() not in (".jpg", ".jpeg", ".png"):
        raise ImageError("Unsupported file type. Accepted formats: JPG, JPEG, PNG.")
    try:
        Image.open(io.BytesIO(raw)).verify()
        img = Image.open(io.BytesIO(raw))
        img.load()
    except (UnidentifiedImageError, OSError) as e:
        raise ImageError(f"This file could not be read as an image ({e}).")
    if img.width < 64 or img.height < 64:
        raise ImageError(f"Image is only {img.width}x{img.height} pixels — too small to be a fundus photograph.")
    return img


def predict(img, head):
    t0 = time.perf_counter()
    prepared = resize_image(img.convert("RGB"), 512, PREP[head])
    buf = io.BytesIO(); prepared.save(buf, "JPEG", quality=95); buf.seek(0)        # the converters' JPEG round trip
    x = TEST_TRANSFORM(Image.open(buf).convert("RGB")).unsqueeze(0)
    pre_ms = (time.perf_counter() - t0) * 1000
    t1 = time.perf_counter()
    with torch.inference_mode():
        patch, prefix = STATE["backbone"].forward_intermediates(
            x, indices=[FORWARD_LAYER], intermediates_only=True, return_prefix_tokens=True, output_fmt="NLC", stop_early=True)[-1]
        feats = torch.cat([prefix[:, 0, :], patch.mean(dim=1)], dim=-1).float()
        logits = STATE["heads"][head]["module"](feats)[0]
        probs = torch.softmax(logits, dim=-1)
    return {"grade": int(probs.argmax()), "probs": [float(p) for p in probs], "raw": [float(v) for v in logits],
            "preprocess_ms": round(pre_ms, 1), "inference_ms": round((time.perf_counter() - t1) * 1000, 1)}


app = FastAPI(title="RFM grader", docs_url=None, redoc_url=None)


def model_info(head):
    h = STATE["heads"].get(head, {})
    return {"model_repo": f"{REPO} ({head} head)", "model_commit": COMMIT, "model_sha256": h.get("model_sha256"),
            "output_calibration": "softmax_applied", "app_version": APP_VERSION}


@app.get("/health")
def health():
    ok = STATE["loaded"]
    return JSONResponse({"status": "ok" if ok else "unhealthy", "model_loaded": ok, "error": STATE["error"], "default_head": DEFAULT_HEAD,
                         "backbone_sha256": STATE.get("backbone_sha"), "load_seconds": STATE["load_seconds"], "tensorflow": None,
                         "heads": {k: {"head_sha256": v["sha"], "model_sha256": v["model_sha256"], "epoch": v["epoch"],
                                       "val_auroc": v["val_score"]} for k, v in STATE["heads"].items()},
                         **model_info(DEFAULT_HEAD)}, status_code=200 if ok else 503)


@app.post("/api/grade")
async def grade(request: Request, head: str = DEFAULT_HEAD):
    if not KEY:
        return JSONResponse({"error": "not_configured", "message": "GRADER_API_KEY is not set"}, status_code=503)
    if not hmac.compare_digest(request.headers.get("x-grader-key", "").encode(), KEY.encode()):
        return JSONResponse({"error": "bad_key", "message": "Wrong key"}, status_code=401)
    if not STATE["loaded"]:
        return JSONResponse({"error": "not_ready", "message": "Model is not loaded"}, status_code=503)
    if head not in STATE["heads"]:
        return JSONResponse({"error": "bad_head", "message": f"head must be one of {sorted(STATE['heads'])}"}, status_code=400)
    raw = await request.body()
    filename = unquote(request.headers.get("x-file-name", "")) or "photo.jpg"
    try:
        img = open_image(raw, filename)
        with _lock:
            r = predict(img, head)
    except ImageError as e:
        return JSONResponse({"error": "image", "message": str(e)}, status_code=422)
    except Exception:
        log.exception("grade failed")
        return JSONResponse({"error": "failed", "message": "Inference failed; details are in the grader's log."}, status_code=500)
    sha = hashlib.sha256(raw).hexdigest()
    log.info("grade ok | image=%s… %dx%d | head=%s | grade=%d | %.0f ms", sha[:12], img.width, img.height, head, r["grade"], r["inference_ms"])
    return JSONResponse({**r, "calibration": "softmax_applied", "image_sha256": sha, "width": img.width, "height": img.height, **model_info(head)})


if __name__ == "__main__":
    import uvicorn
    try:
        build()
    except Exception as e:
        STATE["error"] = str(e)
        log.exception("STARTUP | RFM NOT loaded; /health reports unhealthy and grading is refused")
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("APP_PORT", "7861")), log_level="info", access_log=False)
