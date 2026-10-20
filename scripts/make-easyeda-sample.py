# Writes public/samples/SOT-23-5_regulator.json: a hand-made EasyEDA Standard component (symbol + footprint),
# laid out exactly like EasyEDA's own JSON so the reader is tested against the real field order. MIT.
import json
U = 0.254
def u(mm): return round(mm / U, 4)
ox, oy = 4000, 3000
shape = []
gid = iter(range(1, 999))
def g(): return f"gge{next(gid)}"
pads = [(1, -0.95, 1.3), (2, 0, 1.3), (3, 0.95, 1.3), (4, 0.95, -1.3), (5, -0.95, -1.3)]
w, h = 0.6, 1.1
for n, x, y in pads:
    cx, cy = ox + u(x), oy + u(y)
    pts = [(cx - u(w/2), cy - u(h/2)), (cx + u(w/2), cy - u(h/2)), (cx + u(w/2), cy + u(h/2)), (cx - u(w/2), cy + u(h/2))]
    shape.append(f"PAD~RECT~{cx}~{cy}~{u(w)}~{u(h)}~1~~{n}~0~{' '.join(f'{a} {b}' for a, b in pts)}~0~{g()}~0~~Y~0~0~0.4~{cx},{cy}")
    shape.append(f"SOLIDREGION~100~~M {cx-u(0.2)} {cy-u(0.45)} L {cx+u(0.2)} {cy-u(0.45)} L {cx+u(0.2)} {cy+u(0.45)} L {cx-u(0.2)} {cy+u(0.45)} Z~solid~{g()}~~~~0")
# silkscreen: side bars + a pin-1 notch arc and dot
shape.append(f"TRACK~0.6~3~~{ox-u(1.6)} {oy-u(0.4)} {ox-u(1.6)} {oy+u(0.4)}~{g()}~0")
shape.append(f"TRACK~0.6~3~~{ox+u(1.6)} {oy-u(0.4)} {ox+u(1.6)} {oy+u(0.4)}~{g()}~0")
shape.append(f"ARC~0.6~3~~M {ox-u(1.6)} {oy-u(0.4)} A {u(0.4)} {u(0.4)} 0 0 1 {ox-u(1.2)} {oy-u(0.8)}~~{g()}~0")
shape.append(f"CIRCLE~{ox-u(1.9)}~{oy+u(1.7)}~{u(0.1)}~{u(0.2)}~3~{g()}~0~~")
# fab outline + courtyard-ish document layer
shape.append(f"TRACK~0.4~13~~{ox-u(1.45)} {oy-u(0.8)} {ox+u(1.45)} {oy-u(0.8)} {ox+u(1.45)} {oy+u(0.8)} {ox-u(1.45)} {oy+u(0.8)} {ox-u(1.45)} {oy-u(0.8)}~{g()}~0")
shape.append(f"TEXT~P~{ox-u(1.5)}~{oy-u(2.2)}~0.6~0~0~3~~4.5~U1~~~{g()}")
shape.append(f"TEXT~N~{ox-u(1.5)}~{oy+u(3.2)}~0.6~0~0~13~~4.5~LDO-3.3V~~none~{g()}")
shape.append("SVGNODE~" + json.dumps({"gId": "g1_outline", "nodeName": "g", "nodeType": 1, "layerid": "19", "attrs": {"c_width": "11.4", "c_height": "6.3", "c_rotation": "0,0,0", "z": "0", "c_origin": f"{ox},{oy}", "uuid": "00000000000000000000000000000000", "c_etype": "outline3D", "id": "g1_outline", "title": "SOT-23-5_demo", "layerid": "19"}, "childNodes": []}, separators=(',', ':')))
footprint = {"head": {"docType": "4", "editorVersion": "6.5.40", "c_para": {"package": "SOT-23-5_demo", "pre": "U?", "Contributor": "eda-format-converter"}, "x": ox, "y": oy, "hasIdFlag": True, "newgId": True},
             "canvas": f"CA~1000~1000~#000000~yes~#FFFFFF~10~1000~1000~line~0.5~mm~1~45~visible~0.5~{ox}~{oy}~0~yes", "shape": shape, "layers": [], "objects": [], "BBox": {"x": ox - 10, "y": oy - 10, "width": 20, "height": 20}}
sx, sy = 400, 300
sym = [
    f"R~380~280~2~2~40~50~#880000~1~0~#FFFFFF~{g()}~0~",
    f"P~show~4~1~370~290~180~{g()}~0^^370~290^^M 370 290 h 10~#880000^^1~383~294~0~IN~start~~~#0000FF^^1~375~289~0~1~end~~~#0000FF^^0~377~290^^0~M 380 293 L 383 290 L 380 287",
    f"P~show~1~3~370~310~180~{g()}~0^^370~310^^M 370 310 h 10~#880000^^1~383~314~0~EN~start~~~#0000FF^^1~375~309~0~3~end~~~#0000FF^^0~377~310^^0~M 380 313 L 383 310 L 380 307",
    f"P~show~4~2~400~340~90~{g()}~0^^400~340^^M 400 340 v -10~#880000^^1~400~327~270~GND~start~~~#0000FF^^1~399~335~270~2~end~~~#0000FF^^0~400~333^^0~M 397 330 L 400 327 L 403 330",
    f"P~show~2~5~430~290~0~{g()}~0^^430~290^^M 430 290 h -10~#880000^^1~417~294~0~OUT~end~~~#0000FF^^1~425~289~0~5~start~~~#0000FF^^0~423~290^^0~M 420 287 L 417 290 L 420 293",
    f"P~show~0~4~430~310~0~{g()}~0^^430~310^^M 430 310 h -10~#880000^^1~417~314~0~NC~end~~~#0000FF^^1~425~309~0~4~start~~~#0000FF^^1~423~310^^0~M 420 307 L 417 310 L 420 313",
    f"T~P~380~275~0~#000080~Arial~~~~~comment~U?~1~start~{g()}~0~pinpart",
    f"T~N~380~342~0~#000080~Arial~~~~~comment~LDO-3.3V~1~start~{g()}~0~pinpart",
]
symbol = {"head": {"docType": "2", "editorVersion": "6.5.40", "c_para": {"pre": "U?", "name": "LDO-3.3V", "package": "SOT-23-5_demo", "Manufacturer": "Demo", "Manufacturer Part": "LDO-3.3V-DEMO"}, "x": sx, "y": sy, "hasIdFlag": True},
          "canvas": f"CA~1000~1000~#FFFFFF~yes~#CCCCCC~5~1000~1000~line~5~pixel~5~{sx}~{sy}", "shape": sym, "BBox": {"x": 360, "y": 270, "width": 80, "height": 80}}
doc = {"title": "LDO-3.3V", "description": "Demo 3.3 V LDO in SOT-23-5 (hand-made sample, MIT)", "docType": 2, "dataStr": symbol, "packageDetail": {"title": "SOT-23-5_demo", "docType": 4, "dataStr": footprint}}
json.dump(doc, open("public/samples/SOT-23-5_regulator.json", "w"), indent=1)
print("ok")
