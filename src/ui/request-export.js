export function getExportFormFields(req) {
  return (req.formFields || []).filter(field => field.enabled !== false && field.key);
}

function shellSingleQuote(value) {
  return String(value ?? '').replace(/'/g, "'\\''");
}

function curlFormQuotedValue(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isSafeCurlFormContentType(value) {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(String(value));
}

function isSafeMultipartDispositionValue(value) {
  return !/[\0-\x1f\x7f]/.test(String(value));
}

function multipartQuotedString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function powerShellStringLiteral(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function phpStringLiteral(value) {
  return `'${String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function getExportHeaders(req, omitContentType = false) {
  const headers = [];
  Object.entries(req.requestHeaders || {}).forEach(([key, value]) => {
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'host' || lowerKey === 'proxy-connection' || (omitContentType && lowerKey === 'content-type')) return;
    const values = Array.isArray(value) ? value : [value];
    values.forEach(item => headers.push([key, item]));
  });
  return headers;
}

function getRepeatedExportHeaderName(headers) {
  const seen = new Set();
  for (const [key] of headers) {
    const lowerKey = key.toLowerCase();
    if (seen.has(lowerKey)) return key;
    seen.add(lowerKey);
  }
  return '';
}

function getRepeatedHeaderUnavailableReason(format, headers) {
  const apiName = {
    python: 'Python Requests',
    'javascript-fetch': 'the browser Fetch API',
    powershell: 'Invoke-WebRequest'
  }[format];
  if (!apiName || !getRepeatedExportHeaderName(headers)) return '';
  return `${apiName} cannot guarantee that repeated request header values are sent as separate wire fields.`;
}

function renderNodeExportHeaders(headers, additionalEntries = []) {
  const entries = headers.map(([key, value]) => `${JSON.stringify(key)}, ${JSON.stringify(String(value))}`);
  entries.push(...additionalEntries);
  return `[\n${entries.map(entry => `    ${entry}`).join(',\n')}\n  ]`;
}

function isValidExportBase64(value) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (value.endsWith('==')) return alphabet.indexOf(value.at(-3)) % 16 === 0;
  if (value.endsWith('=')) return alphabet.indexOf(value.at(-2)) % 4 === 0;
  return true;
}

function getExportRequestBody(req) {
  if (req.requestBodyTruncated === true) {
    return {
      kind: 'unavailable',
      reason: 'The captured request body is incomplete, so its original bytes cannot be replayed.'
    };
  }

  const value = String(req.requestBody ?? '');
  if (String(req.requestBodyEncoding || '').toLowerCase() !== 'base64') {
    return { kind: 'text', value };
  }

  const match = /^data:[^,\r\n]*;base64,([A-Za-z0-9+/=]*)$/i.exec(value);
  if (!match || !isValidExportBase64(match[1])) {
    return {
      kind: 'unavailable',
      reason: 'The captured request body has invalid base64 metadata, so its original bytes cannot be replayed.'
    };
  }
  return { kind: 'base64', value: match[1] };
}

function generateUnavailableExportSnippet(format, reason) {
  const prefix = ['javascript-fetch', 'javascript-node', 'php', 'go'].includes(format) ? '//' : '#';
  return `${prefix} EXACT REPLAY UNAVAILABLE\n${prefix} ${reason}\n${prefix} No request was generated.`;
}

function generateMultipartExportSnippet(req, format) {
  const fields = getExportFormFields(req);
  const headers = getExportHeaders(req, true);
  const method = String(req.method || 'POST');
  const url = String(req.url || '');
  const repeatedHeaderReason = getRepeatedHeaderUnavailableReason(format, headers);
  if (repeatedHeaderReason) return generateUnavailableExportSnippet(format, repeatedHeaderReason);

  if (format === 'powershell' || format === 'php') {
    const unsafeField = fields.find((field) => {
      if (!isSafeMultipartDispositionValue(field.key)) return true;
      if (field.type !== 'file') return false;
      const filename = field.file?.name || field.fileName || 'file';
      const contentType = field.file?.type || field.fileType || 'application/octet-stream';
      return !isSafeMultipartDispositionValue(filename) || !isSafeCurlFormContentType(contentType);
    });
    if (unsafeField) {
      return generateUnavailableExportSnippet(
        format,
        'The captured multipart field or file metadata cannot be represented safely in MIME headers.'
      );
    }
  }

  if (format === 'curl') {
    const unsafeFileField = fields.find((field) => {
      if (field.type !== 'file') return false;
      const fileName = String(field.file?.name || field.fileName || 'file');
      const contentType = field.file?.type || field.fileType;
      return String(field.key).includes('=')
        || fileName === '-'
        || (contentType && !isSafeCurlFormContentType(contentType));
    });
    if (unsafeFileField) {
      return generateUnavailableExportSnippet(
        format,
        'The captured file metadata cannot be represented safely in cURL form syntax.'
      );
    }
    let cmd = `curl -X '${shellSingleQuote(method)}' '${shellSingleQuote(url)}'`;
    headers.forEach(([key, value]) => { cmd += ` \\\n  -H '${shellSingleQuote(key)}: ${shellSingleQuote(value)}'`; });
    fields.forEach((field) => {
      if (field.type === 'file') {
        const contentType = field.file?.type || field.fileType;
        const fileName = curlFormQuotedValue(field.file?.name || field.fileName || 'file');
        const value = `@${fileName}${contentType ? `;type=${contentType}` : ''}`;
        cmd += ` \\\n  -F '${shellSingleQuote(field.key)}=${shellSingleQuote(value)}'`;
      } else {
        cmd += ` \\\n  --form-string '${shellSingleQuote(field.key)}=${shellSingleQuote(field.value || '')}'`;
      }
    });
    return cmd;
  }

  if (format === 'python') {
    const textFields = fields.filter(field => field.type !== 'file');
    const fileFields = fields.filter(field => field.type === 'file');
    let code = 'import requests\n\n';
    if (textFields.length) {
      code += `data = [\n${textFields.map(field => `    (${JSON.stringify(field.key)}, ${JSON.stringify(field.value || '')})`).join(',\n')}\n]\n`;
    }
    if (fileFields.length) {
      code += `files = [\n${fileFields.map(field => {
        const filename = field.file?.name || field.fileName || 'file';
        const contentType = field.file?.type || field.fileType || 'application/octet-stream';
        return `    (${JSON.stringify(field.key)}, (${JSON.stringify(filename)}, open(${JSON.stringify(filename)}, 'rb'), ${JSON.stringify(contentType)}))`;
      }).join(',\n')}\n]\n`;
    }
    code += `\nresponse = requests.request(\n    ${JSON.stringify(method)},\n    ${JSON.stringify(url)}`;
    if (headers.length) code += `,\n    headers={\n${headers.map(([key, value]) => `        ${JSON.stringify(key)}: ${JSON.stringify(String(value))}`).join(',\n')}\n    }`;
    if (textFields.length) code += ',\n    data=data';
    if (fileFields.length) code += ',\n    files=files';
    code += '\n)\n\nprint(response.status_code)\nprint(response.text)';
    return code;
  }

  if (format === 'javascript-fetch') {
    const fileCount = fields.filter(field => field.type === 'file').length;
    let code = '';
    if (fileCount) {
      const fileLabel = fileCount === 1 ? 'file' : 'files';
      const inputHint = fileCount === 1
        ? 'Select the captured file before running this snippet.'
        : 'Use a multiple file input and select files in captured multipart part order.';
      code += `const requiredFileCount = ${fileCount};\n`;
      code += `const fileInput = document.querySelector('input[type="file"]'); // ${inputHint}\n`;
      code += 'const selectedFiles = Array.from(fileInput?.files || []);\n';
      code += 'if (selectedFiles.length < requiredFileCount) {\n';
      code += `  throw new Error(${JSON.stringify(`Select at least ${fileCount} ${fileLabel} in captured multipart part order before running this snippet.`)});\n`;
      code += '}\n';
    }
    code += 'const formData = new FormData();\n';
    let fileIndex = 0;
    fields.forEach((field) => {
      if (field.type === 'file') {
        const filename = field.file?.name || field.fileName || 'file';
        code += `formData.append(${JSON.stringify(field.key)}, selectedFiles[${fileIndex++}], ${JSON.stringify(filename)});\n`;
      } else {
        code += `formData.append(${JSON.stringify(field.key)}, ${JSON.stringify(field.value || '')});\n`;
      }
    });
    code += `\nconst response = await fetch(${JSON.stringify(url)}, {\n  method: ${JSON.stringify(method)}`;
    if (headers.length) code += `,\n  headers: {\n${headers.map(([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(String(value))}`).join(',\n')}\n  }`;
    code += ',\n  body: formData\n});\n\nconsole.log(response.status, await response.text());';
    return code;
  }

  if (format === 'javascript-node') {
    const boundary = req.multipartBoundary || '----HTTPFreeKitBoundary';
    let code = "const fs = require('fs');\nconst http = require('http');\nconst https = require('https');\n\n";
    code += `const boundary = ${JSON.stringify(boundary)};\nconst chunks = [];\nconst append = value => chunks.push(Buffer.from(value));\n`;
    fields.forEach((field) => {
      const safeName = String(field.key).replace(/["\r\n]/g, '_');
      code += `append('--' + boundary + '\\r\\n');\n`;
      if (field.type === 'file') {
        const filename = field.file?.name || field.fileName || 'file';
        const safeFilename = filename.replace(/["\r\n]/g, '_');
        const contentType = field.file?.type || field.fileType || 'application/octet-stream';
        code += `append(${JSON.stringify(`Content-Disposition: form-data; name="${safeName}"; filename="${safeFilename}"\r\n`)});\n`;
        code += `append(${JSON.stringify(`Content-Type: ${contentType}\r\n\r\n`)});\n`;
        code += `chunks.push(fs.readFileSync(${JSON.stringify(filename)}));\nappend('\\r\\n');\n`;
      } else {
        code += `append(${JSON.stringify(`Content-Disposition: form-data; name="${safeName}"\r\n\r\n${field.value || ''}\r\n`)});\n`;
      }
    });
    code += `append('--' + boundary + '--\\r\\n');\nconst body = Buffer.concat(chunks);\nconst target = new URL(${JSON.stringify(url)});\n`;
    const nodeHeaders = renderNodeExportHeaders(headers, [
      `${JSON.stringify('Content-Type')}, 'multipart/form-data; boundary=' + boundary`,
      `${JSON.stringify('Content-Length')}, String(body.length)`
    ]);
    code += `const options = {\n  method: ${JSON.stringify(method)},\n  hostname: target.hostname,\n  port: target.port || undefined,\n  path: target.pathname + target.search,\n  headers: ${nodeHeaders}\n};\n\n`;
    code += `const request = (target.protocol === 'https:' ? https : http).request(options, response => {\n  let data = '';\n  response.on('data', chunk => data += chunk);\n  response.on('end', () => console.log(response.statusCode, data));\n});\nrequest.write(body);\nrequest.end();`;
    return code;
  }

  if (format === 'powershell') {
    let code = '$headers = @{}\n';
    headers.forEach(([key, value]) => { code += `$headers[${powerShellStringLiteral(key)}] = ${powerShellStringLiteral(value)}\n`; });
    code += "\n$boundary = '----HTTPFreeKit' + [Guid]::NewGuid().ToString('N')\n";
    code += '$bodyStream = [System.IO.MemoryStream]::new()\n';
    code += '$multipartUtf8 = [System.Text.UTF8Encoding]::new($false)\n';
    code += '$writeMultipartText = {\n';
    code += '    param([string]$value)\n';
    code += '    [byte[]]$bytes = $multipartUtf8.GetBytes($value)\n';
    code += '    $bodyStream.Write($bytes, 0, $bytes.Length)\n';
    code += '}\n\ntry {\n';
    fields.forEach((field, index) => {
      const safeName = multipartQuotedString(field.key);
      code += '    & $writeMultipartText (\'--\' + $boundary + "`r`n")\n';
      if (field.type === 'file') {
        const filename = field.file?.name || field.fileName || 'file';
        const safeFilename = multipartQuotedString(filename);
        const contentType = field.file?.type || field.fileType || 'application/octet-stream';
        code += `    & $writeMultipartText ${powerShellStringLiteral(`Content-Disposition: form-data; name="${safeName}"; filename="${safeFilename}"`)}\n`;
        code += '    & $writeMultipartText "`r`n"\n';
        code += `    & $writeMultipartText ${powerShellStringLiteral(`Content-Type: ${contentType}`)}\n`;
        code += '    & $writeMultipartText "`r`n`r`n"\n';
        code += `    $multipartFile${index} = [System.IO.File]::OpenRead(${powerShellStringLiteral(filename)})\n`;
        code += `    try { $multipartFile${index}.CopyTo($bodyStream) } finally { $multipartFile${index}.Dispose() }\n`;
      } else {
        code += `    & $writeMultipartText ${powerShellStringLiteral(`Content-Disposition: form-data; name="${safeName}"`)}\n`;
        code += '    & $writeMultipartText "`r`n`r`n"\n';
        code += `    & $writeMultipartText ${powerShellStringLiteral(field.value || '')}\n`;
      }
      code += '    & $writeMultipartText "`r`n"\n';
    });
    code += '    & $writeMultipartText (\'--\' + $boundary + "--`r`n")\n';
    code += '    [byte[]]$body = $bodyStream.ToArray()\n';
    code += '} finally {\n    $bodyStream.Dispose()\n}\n\n';
    code += `$response = Invoke-WebRequest -Uri ${powerShellStringLiteral(url)} -Method ${powerShellStringLiteral(method)} -Headers $headers -ContentType ('multipart/form-data; boundary=' + $boundary) -Body $body\n$response.StatusCode\n$response.Content`;
    return code;
  }

  if (format === 'wget') {
    const boundary = req.multipartBoundary || '----HTTPFreeKitBoundary';
    let code = `boundary='${shellSingleQuote(boundary)}'\nbody_file=$(mktemp)\n{\n`;
    fields.forEach((field) => {
      const safeName = String(field.key).replace(/["\r\n]/g, '_');
      code += `  printf '%s\\r\\n' "--$boundary"\n`;
      if (field.type === 'file') {
        const filename = field.file?.name || field.fileName || 'file';
        const safeFilename = filename.replace(/["\r\n]/g, '_');
        const contentType = field.file?.type || field.fileType || 'application/octet-stream';
        code += `  printf '%s\\r\\n' '${shellSingleQuote(`Content-Disposition: form-data; name="${safeName}"; filename="${safeFilename}"`)}'\n`;
        code += `  printf '%s\\r\\n\\r\\n' '${shellSingleQuote(`Content-Type: ${contentType}`)}'\n  cat '${shellSingleQuote(filename)}'\n  printf '\\r\\n'\n`;
      } else {
        code += `  printf '%s\\r\\n\\r\\n' '${shellSingleQuote(`Content-Disposition: form-data; name="${safeName}"`)}'\n`;
        code += `  printf '%s\\r\\n' '${shellSingleQuote(field.value || '')}'\n`;
      }
    });
    code += `  printf '%s--\\r\\n' "--$boundary"\n} > "$body_file"\n\nwget --method='${shellSingleQuote(method)}'`;
    headers.forEach(([key, value]) => { code += ` \\\n  --header='${shellSingleQuote(key)}: ${shellSingleQuote(value)}'`; });
    code += ` \\\n  --header="Content-Type: multipart/form-data; boundary=$boundary" \\\n  --body-file="$body_file" \\\n  '${shellSingleQuote(url)}'\nrm -f "$body_file"`;
    return code;
  }

  if (format === 'php') {
    let code = `<?php\n$boundary = '----HTTPFreeKit' . bin2hex(random_bytes(16));\n$body = '';\n`;
    fields.forEach((field, index) => {
      const safeName = multipartQuotedString(field.key);
      code += `$body .= '--' . $boundary . "\\r\\n";\n`;
      if (field.type === 'file') {
        const filename = field.file?.name || field.fileName || 'file';
        const safeFilename = multipartQuotedString(filename);
        const contentType = field.file?.type || field.fileType || 'application/octet-stream';
        code += `$body .= ${phpStringLiteral(`Content-Disposition: form-data; name="${safeName}"; filename="${safeFilename}"`)} . "\\r\\n";\n`;
        code += `$body .= ${phpStringLiteral(`Content-Type: ${contentType}`)} . "\\r\\n\\r\\n";\n`;
        code += `$multipartFile${index} = file_get_contents(${phpStringLiteral(filename)});\n`;
        code += `if ($multipartFile${index} === false) {\n    throw new RuntimeException(${phpStringLiteral(`Unable to read multipart file ${index}`)});\n}\n`;
        code += `$body .= $multipartFile${index};\n`;
      } else {
        code += `$body .= ${phpStringLiteral(`Content-Disposition: form-data; name="${safeName}"`)} . "\\r\\n\\r\\n";\n`;
        code += `$body .= ${phpStringLiteral(field.value || '')};\n`;
      }
      code += `$body .= "\\r\\n";\n`;
    });
    code += `$body .= '--' . $boundary . "--\\r\\n";\n\n`;
    code += `$ch = curl_init(${phpStringLiteral(url)});\n`;
    code += `curl_setopt($ch, CURLOPT_CUSTOMREQUEST, ${phpStringLiteral(method)});\ncurl_setopt($ch, CURLOPT_RETURNTRANSFER, true);\ncurl_setopt($ch, CURLOPT_POSTFIELDS, $body);\n`;
    const headerLines = headers.map(([key, value]) => `    ${phpStringLiteral(`${key}: ${value}`)}`);
    headerLines.push("    'Content-Type: multipart/form-data; boundary=' . $boundary");
    code += `curl_setopt($ch, CURLOPT_HTTPHEADER, [\n${headerLines.join(',\n')}\n]);\n`;
    code += `$response = curl_exec($ch);\n$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);\ncurl_close($ch);\necho $httpCode . "\\n" . $response;\n?>`;
    return code;
  }

  if (format === 'go') {
    const hasFiles = fields.some(field => field.type === 'file');
    let code = 'package main\n\nimport (\n\t"bytes"\n\t"fmt"\n\t"mime/multipart"\n\t"net/http"\n';
    if (hasFiles) code += '\t"io"\n\t"os"\n';
    code += ')\n\nfunc main() {\n\tvar body bytes.Buffer\n\twriter := multipart.NewWriter(&body)\n';
    let fileIndex = 0;
    fields.forEach((field) => {
      if (field.type === 'file') {
        const filename = field.file?.name || field.fileName || 'file';
        const index = fileIndex++;
        code += `\tfile${index}, _ := os.Open(${JSON.stringify(filename)})\n\tdefer file${index}.Close()\n`;
        code += `\tpart${index}, _ := writer.CreateFormFile(${JSON.stringify(field.key)}, ${JSON.stringify(filename)})\n\tio.Copy(part${index}, file${index})\n`;
      } else {
        code += `\twriter.WriteField(${JSON.stringify(field.key)}, ${JSON.stringify(field.value || '')})\n`;
      }
    });
    code += `\twriter.Close()\n\n\treq, _ := http.NewRequest(${JSON.stringify(method)}, ${JSON.stringify(url)}, &body)\n`;
    headers.forEach(([key, value]) => { code += `\treq.Header.Add(${JSON.stringify(key)}, ${JSON.stringify(String(value))})\n`; });
    code += '\treq.Header.Set("Content-Type", writer.FormDataContentType())\n\tresp, _ := http.DefaultClient.Do(req)\n\tdefer resp.Body.Close()\n\tfmt.Println(resp.StatusCode)\n}';
    return code;
  }

  return '';
}

function findHeaderKey(headers, name) {
  const lowerName = name.toLowerCase();
  return Object.keys(headers).find(key => key.toLowerCase() === lowerName) || null;
}

export function generateExportSnippet(req, format) {
  if (req.bodyType === 'urlencoded') {
    const params = new URLSearchParams();
    getExportFormFields(req).forEach(field => params.append(field.key, field.value || ''));
    const headers = { ...(req.requestHeaders || {}) };
    if (!findHeaderKey(headers, 'Content-Type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    return generateExportSnippet({
      ...req,
      bodyType: 'raw',
      requestHeaders: headers,
      requestBody: params.toString(),
      requestBodyEncoding: 'utf8',
      requestBodyTruncated: false
    }, format);
  }
  if (req.bodyType === 'multipart') return generateMultipartExportSnippet(req, format);

  const method = String(req.method || 'GET');
  const url = String(req.url || '');
  const exportBody = getExportRequestBody(req);
  if (exportBody.kind === 'unavailable') {
    return generateUnavailableExportSnippet(format, exportBody.reason);
  }
  const body = exportBody.value;
  const isBinaryBody = exportBody.kind === 'base64' && body.length > 0;
  const headers = getExportHeaders(req);
  const hasBody = body.length > 0;
  const repeatedHeaderReason = getRepeatedHeaderUnavailableReason(format, headers);
  if (repeatedHeaderReason) return generateUnavailableExportSnippet(format, repeatedHeaderReason);

  switch (format) {
    case 'curl': {
      let cmd = `curl -X '${shellSingleQuote(method)}' '${shellSingleQuote(url)}'`;
      for (const [key, value] of headers) {
        cmd += ` \\\n  -H '${shellSingleQuote(`${key}: ${value}`)}'`;
      }
      if (hasBody && isBinaryBody) {
        cmd = `printf '%s' '${shellSingleQuote(body)}' | base64 --decode | ${cmd} \\\n  --data-binary @-`;
      } else if (hasBody) {
        cmd += ` \\\n  --data-raw '${shellSingleQuote(body)}'`;
      }
      return cmd;
    }
    case 'python': {
      let code = isBinaryBody ? `import base64\nimport requests\n\n` : `import requests\n\n`;
      code += `response = requests.request(\n    ${JSON.stringify(method)},\n    ${JSON.stringify(url)}`;
      if (headers.length) {
        code += `,\n    headers={\n${headers.map(([key, value]) => `        ${JSON.stringify(key)}: ${JSON.stringify(String(value))}`).join(',\n')}\n    }`;
      }
      if (hasBody) {
        code += isBinaryBody
          ? `,\n    data=base64.b64decode(${JSON.stringify(body)})`
          : `,\n    data=${JSON.stringify(body)}`;
      }
      code += `\n)\n\nprint(response.status_code)\nprint(response.text)`;
      return code;
    }
    case 'javascript-fetch': {
      let code = `const response = await fetch(${JSON.stringify(url)}, {\n  method: ${JSON.stringify(method)}`;
      if (headers.length) {
        code += `,\n  headers: {\n${headers.map(([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(String(value))}`).join(',\n')}\n  }`;
      }
      if (hasBody) {
        code += isBinaryBody
          ? `,\n  body: Uint8Array.from(atob(${JSON.stringify(body)}), character => character.charCodeAt(0))`
          : `,\n  body: ${JSON.stringify(body)}`;
      }
      code += `\n});\n\nconst data = await response.text();\nconsole.log(response.status, data);`;
      return code;
    }
    case 'javascript-node': {
      let code = `const https = require('https');\nconst http = require('http');\n\n`;
      code += `const target = new URL(${JSON.stringify(url)});\n`;
      code += `const options = {\n  method: ${JSON.stringify(method)},\n  hostname: target.hostname,\n  path: target.pathname + target.search,\n  port: target.port || undefined`;
      if (headers.length) {
        code += `,\n  headers: ${renderNodeExportHeaders(headers)}`;
      }
      code += `\n};\n\nconst request = (target.protocol === 'https:' ? https : http).request(options, (response) => {\n  let data = '';\n  response.on('data', chunk => data += chunk);\n  response.on('end', () => console.log(response.statusCode, data));\n});\n`;
      if (hasBody) {
        code += isBinaryBody
          ? `request.write(Buffer.from(${JSON.stringify(body)}, 'base64'));\n`
          : `request.write(${JSON.stringify(body)});\n`;
      }
      code += `request.end();`;
      return code;
    }
    case 'powershell': {
      let code = `$headers = @{}\n`;
      for (const [key, value] of headers) {
        code += `$headers[${powerShellStringLiteral(key)}] = ${powerShellStringLiteral(value)}\n`;
      }
      code += `\n$response = Invoke-WebRequest -Uri ${powerShellStringLiteral(url)} -Method ${powerShellStringLiteral(method)} -Headers $headers`;
      if (hasBody) {
        code += isBinaryBody
          ? ` -Body ([Convert]::FromBase64String(${powerShellStringLiteral(body)}))`
          : ` -Body ${powerShellStringLiteral(body)}`;
      }
      code += `\n$response.StatusCode\n$response.Content`;
      return code;
    }
    case 'wget': {
      let cmd = `wget --method='${shellSingleQuote(method)}'`;
      for (const [key, value] of headers) {
        cmd += ` \\\n  --header='${shellSingleQuote(`${key}: ${value}`)}'`;
      }
      if (hasBody && isBinaryBody) {
        cmd = `body_file=$(mktemp) || exit 1\ntrap 'rm -f "$body_file"' EXIT\ntrap 'exit 1' HUP INT TERM\nprintf '%s' '${shellSingleQuote(body)}' | base64 --decode > "$body_file" || exit 1\n\n${cmd} \\\n  --body-file="$body_file"`;
      } else if (hasBody) {
        cmd += ` \\\n  --body-data='${shellSingleQuote(body)}'`;
      }
      cmd += ` \\\n  '${shellSingleQuote(url)}'`;
      return cmd;
    }
    case 'php': {
      let code = '<?php\n';
      if (hasBody && isBinaryBody) {
        code += `$body = base64_decode(${phpStringLiteral(body)}, true);\nif ($body === false) {\n    throw new RuntimeException('Invalid captured request body');\n}\n`;
      }
      code += `$ch = curl_init();\ncurl_setopt($ch, CURLOPT_URL, ${phpStringLiteral(url)});\ncurl_setopt($ch, CURLOPT_CUSTOMREQUEST, ${phpStringLiteral(method)});\ncurl_setopt($ch, CURLOPT_RETURNTRANSFER, true);\n`;
      if (headers.length) {
        code += `curl_setopt($ch, CURLOPT_HTTPHEADER, [\n${headers.map(([key, value]) => `    ${phpStringLiteral(`${key}: ${value}`)}`).join(',\n')}\n]);\n`;
      }
      if (hasBody) {
        code += isBinaryBody
          ? 'curl_setopt($ch, CURLOPT_POSTFIELDS, $body);\n'
          : `curl_setopt($ch, CURLOPT_POSTFIELDS, ${phpStringLiteral(body)});\n`;
      }
      code += `$response = curl_exec($ch);\n$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);\ncurl_close($ch);\necho $httpCode . "\\n" . $response;\n?>`;
      return code;
    }
    case 'go': {
      let code = `package main\n\nimport (\n\t"fmt"\n\t"io"\n\t"net/http"\n`;
      if (hasBody && isBinaryBody) code += `\t"bytes"\n\t"encoding/base64"\n`;
      else if (hasBody) code += `\t"strings"\n`;
      code += `)\n\nfunc main() {\n`;
      if (hasBody) {
        if (isBinaryBody) {
          code += `\tbodyBytes, err := base64.StdEncoding.DecodeString(${JSON.stringify(body)})\n`;
          code += `\tif err != nil {\n\t\tpanic(err)\n\t}\n`;
          code += `\tbody := bytes.NewReader(bodyBytes)\n`;
        } else {
          code += `\tbody := strings.NewReader(${JSON.stringify(body)})\n`;
        }
        code += `\treq, _ := http.NewRequest(${JSON.stringify(method)}, ${JSON.stringify(url)}, body)\n`;
      } else {
        code += `\treq, _ := http.NewRequest(${JSON.stringify(method)}, ${JSON.stringify(url)}, nil)\n`;
      }
      for (const [key, value] of headers) {
        code += `\treq.Header.Add(${JSON.stringify(key)}, ${JSON.stringify(String(value))})\n`;
      }
      code += `\n\tresp, _ := http.DefaultClient.Do(req)\n\tdefer resp.Body.Close()\n\tdata, _ := io.ReadAll(resp.Body)\n\tfmt.Println(resp.StatusCode, string(data))\n}`;
      return code;
    }
    default:
      return `// Unknown format: ${format}`;
  }
}
