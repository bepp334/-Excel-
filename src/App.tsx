/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleGenAI, Type, GenerateContentResponse } from "@google/genai";
import ExcelJS from 'exceljs';
import { useDropzone } from 'react-dropzone';
import * as pdfjs from 'pdfjs-dist';
import { 
  FileText, 
  Download, 
  Loader2, 
  AlertCircle, 
  CheckCircle2, 
  Upload,
  Table as TableIcon,
  FileSpreadsheet,
  Image as ImageIcon,
  Trash2,
  ChevronUp,
  ChevronDown,
  Undo2,
  Edit3
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Set PDF.js worker
const PDFJS_VERSION = '5.4.624';
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

// --- Types ---

interface ScenarioStep {
  stepNumber: string;
  type: string;
  text: string;
  hasImage: boolean;
  imageBox?: [number, number, number, number]; // [ymin, xmin, ymax, xmax] in normalized coordinates (0-1000)
}

interface ScenarioData {
  scenarioName: string;
  steps: ScenarioStep[];
  deliveryFormat?: string;
  deliverySegment?: string;
  deliveryDate?: string;
  referenceSite?: string;
}

// --- Sub-components ---

function StepImage({ box, imageData }: { box: [number, number, number, number], imageData: string }) {
  const [croppedUrl, setCroppedUrl] = useState<string | null>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const [ymin, xmin, ymax, xmax] = box;
      const width = img.naturalWidth;
      const height = img.naturalHeight;

      const sx = (xmin / 1000) * width;
      const sy = (ymin / 1000) * height;
      const sw = ((xmax - xmin) / 1000) * width;
      const sh = ((ymax - ymin) / 1000) * height;

      if (sw <= 0 || sh <= 0) return;

      canvas.width = sw;
      canvas.height = sh;
      // Ensure canvas is transparent before drawing
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      setCroppedUrl(canvas.toDataURL('image/png'));
    };
    img.src = imageData;
  }, [box, imageData]);

  if (!croppedUrl) return <div className="w-16 h-12 bg-gray-100 animate-pulse rounded" />;

  return (
    <div className="relative group">
      <img 
        src={croppedUrl} 
        alt="Cropped step" 
        className="h-12 w-auto rounded border border-gray-200 shadow-sm hover:scale-150 transition-transform origin-left cursor-zoom-in z-10 relative"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}

// --- App Component ---

export default function App() {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [results, setResults] = useState<{ file: File, data: ScenarioData, imageData: string }[]>([]);
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const [history, setHistory] = useState<{ file: File, data: ScenarioData, imageData: string }[][]>([]);
  const [error, setError] = useState<string | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [currentImageForCrop, setCurrentImageForCrop] = useState<string | null>(null);
  const [customFileName, setCustomFileName] = useState<string>('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);

  const convertPdfToImage = async (pdfFile: File): Promise<string> => {
    try {
      const arrayBuffer = await pdfFile.arrayBuffer();
      const loadingTask = pdfjs.getDocument({
        data: arrayBuffer,
        cMapUrl: `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/cmaps/`,
        cMapPacked: true,
      });
      const pdf = await loadingTask.promise;
      const scale = 3.0;

      // 全ページをレンダリングして縦に結合
      const pageCanvases: HTMLCanvasElement[] = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not get canvas context');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        context.clearRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport } as any).promise;
        pageCanvases.push(canvas);
      }

      if (pageCanvases.length === 1) {
        return pageCanvases[0].toDataURL('image/png');
      }

      // 複数ページを縦に結合
      const totalWidth = Math.max(...pageCanvases.map(c => c.width));
      const totalHeight = pageCanvases.reduce((sum, c) => sum + c.height, 0);
      const merged = document.createElement('canvas');
      merged.width = totalWidth;
      merged.height = totalHeight;
      const ctx = merged.getContext('2d')!;
      let yOffset = 0;
      for (const c of pageCanvases) {
        ctx.drawImage(c, 0, yOffset);
        yOffset += c.height;
      }
      return merged.toDataURL('image/png');
    } catch (err) {
      console.error('PDF conversion error details:', err);
      throw err;
    }
  };

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      setSelectedFiles(prev => [...prev, ...acceptedFiles]);
      setError(null);
    }
  }, []);

  const removeSelectedFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleStartAnalysis = async () => {
    if (selectedFiles.length === 0) return;

    setResults([]);
    setActiveResultIndex(0);
    setHistory([]);
    setError(null);
    setIsAnalyzing(true);
    
    const newResults: { file: File, data: ScenarioData, imageData: string }[] = [];

    try {
      const resultsArray: ({ file: File, data: ScenarioData, imageData: string } | null)[] = [];
      
      for (let i = 0; i < selectedFiles.length; i++) {
        const selectedFile = selectedFiles[i];
        
        // Add a small delay between requests to avoid rate limits (except for the first one)
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        let dataUrl = '';
        if (selectedFile.type === 'application/pdf') {
          dataUrl = await convertPdfToImage(selectedFile);
        } else {
          dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(selectedFile);
          });
        }
        
        const data = await analyzeScenario(dataUrl);
        if (data) {
          resultsArray.push({ file: selectedFile, data, imageData: dataUrl });
        }
      }

      const newResults = resultsArray.filter((res): res is { file: File, data: ScenarioData, imageData: string } => res !== null);

      setResults(newResults);
      setSelectedFiles([]);
      if (newResults.length > 0) {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const dateStr = `${year}${month}${day}`;
        setCustomFileName(`【○○ 御中】△△のご提案_${dateStr}`);
      }
    } catch (err: any) {
      console.error('File processing error:', err);
      setError(`ファイルの読み込みまたは解析に失敗しました: ${err.message || '不明なエラー'}`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/*': ['.jpeg', '.jpg', '.png'],
      'application/pdf': ['.pdf']
    },
    multiple: true
  } as any);

  const analyzeScenario = async (dataUrl: string, retryCount = 0): Promise<ScenarioData | null> => {
    try {
      const effectiveApiKey = import.meta.env.VITE_GEMINI_API_KEY;
      if (!effectiveApiKey) {
        throw new Error('APIキーが設定されていません。Vercelの環境変数に VITE_GEMINI_API_KEY を設定してください。');
      }
      const ai = new GoogleGenAI({ apiKey: effectiveApiKey });
      const base64Data = dataUrl.split(',')[1];
      
      const prompt = `
        この画像はチャットやメッセージの「シナリオ」フロー図です。
        画像内の各ステップ（#1, #2, #3...）を解析し、以下の情報を抽出してください。
        
        【分類ルール】
        - テキスト：テキストのみのブロック
        - オルトテキスト：テキストと画像が同じブロックにある場合の「上部の導入テキスト部分」
        - 画像：画像本体（ボタンやカードなど）と、その直近に付随する補足テキスト（例：＼月額 330 円 ( 税込 ) ！／ などの金額表示やキャッチコピー）を含む範囲。これらは一つの画像として境界ボックスを抽出してください。（※画像の内容説明は不要です。textは空文字にしてください）
        - URL：URLのみのブロック（※「Continue to URL: 」という文言は含めず、URLのみを抽出してください）

        【除外ルール】
        - 「Image Button」と書かれた要素は解析対象から除外し、出力に含めないでください。

        【重要：絵文字の扱い】
        - 画像内に絵文字（例：😊, 🚀, ✅, 💡など）が含まれている場合、必ず「画像にあるものと全く同じUnicode絵文字」を特定してテキストに抽出してください。
        - 似たような別の絵文字に置き換えることは絶対にしないでください（例：チェックマークが複数ある場合、画像と同じ形状のものを選択する）。
        - 絵文字を「（笑顔）」のような言葉に置き換えたり、文字化けさせたりしないでください。
        - Unicodeの絵文字として正確に出力してください。

        【重要：改行の扱い】
        - 長い文章において、見た目上の都合（枠幅など）で改行されている場合は、改行を入れずに1つの文章として繋げてください。
        - ただし、画像内で「1行空いている（明確な段落分けがある）」箇所については、改行を保持してください。
        - 単なる折り返しによる改行は削除し、意図的な段落分けのみを改行として出力してください。

        【重要：抽出ルール】
        - テキストと画像が同じブロックにある場合は、必ず「オルトテキスト」と「画像」の2つの要素に分けて、順番通りにリストに追加してください。
        - 各ステップの境界ボックス（imageBox）は、余白や周囲の境界線（青い線など）を含めず、画像の内容（赤いカード部分など）のみを正確に、かつ端が切れないギリギリの範囲で抽出してください。
        - imageBoxの座標は0〜1000の正規化座標です。画像全体の幅・高さをそれぞれ1000として計算してください。
        - 座標の精度が特に重要です。実際に画像上の要素の上端・左端・下端・右端のピクセル位置を正確に計測し、1000スケールに変換してください。
        - 画像内の要素が横に並んでいる場合（例：複数の画像カードが水平に並んでいる）、それぞれのステップの ymin が近い値になるはずです。正確な座標を返してください。

        1. シナリオ名 (画像上部の Scenario: 以降のテキスト)
        2. 各ステップの詳細:
           - stepNumber: ステップ番号 (例: #1)
           - type: 上記の分類（テキスト, オルトテキスト, 画像, URL）
           - text: 内容（テキスト、URL、または画像の説明。絵文字は画像と全く同じものをそのまま保持すること。勝手な変換は厳禁です）
           - hasImage: 画像が含まれているかどうか (true/false)
           - imageBox: そのステップの要素全体を囲む境界ボックス [ymin, xmin, ymax, xmax] (0-1000の正規化座標)。画像がない場合も、テキストの位置を示すボックスを返してください。

        結果は必ず以下のJSON形式で返してください。
        {
          "scenarioName": "シナリオ名",
          "steps": [
            { "stepNumber": "#1", "type": "テキスト", "text": "本文...", "hasImage": false, "imageBox": null },
            ...
          ]
        }
      `;

      const response: GenerateContentResponse = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: {
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: "image/png",
                data: base64Data
              }
            }
          ]
        },
        config: {
          mediaResolution: "media_resolution_high" as any,
          systemInstruction: "あなたはプロのOCRエンジニアです。画像内のテキストを正確に抽出してください。特に絵文字は、画像にあるものと全く同じUnicode絵文字を特定して出力してください。似たような別の絵文字に置き換えることは厳禁です。一字一句、一記号、一絵文字たりとも勝手に変換しないでください。また、imageBoxの座標は画像全体を1000×1000として計算した正規化座標を返してください。",
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              scenarioName: { type: Type.STRING },
              steps: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    stepNumber: { type: Type.STRING },
                    type: { type: Type.STRING },
                    text: { type: Type.STRING },
                    hasImage: { type: Type.BOOLEAN },
                    imageBox: { 
                      type: Type.ARRAY, 
                      items: { type: Type.NUMBER },
                      description: "[ymin, xmin, ymax, xmax] normalized 0-1000"
                    }
                  },
                  required: ["stepNumber", "type", "text", "hasImage"]
                }
              }
            },
            required: ["scenarioName", "steps"]
          }
        }
      });

      const data = JSON.parse(response.text || '{}') as ScenarioData;
      
      // Set default reference site to empty string so it's visible by default
      if (data.referenceSite === undefined) {
        data.referenceSite = '';
      }
      
      // Filter out any "Image Button" steps just in case AI included them
      if (data.steps) {
        data.steps = data.steps.filter(step => 
          !step.text.toLowerCase().includes('image button') && 
          step.type !== 'image button'
        );
      }
      
      return data;
    } catch (err: any) {
      // Handle rate limit (429) errors with exponential backoff
      if (err.message?.includes('429') || err.status === 'RESOURCE_EXHAUSTED') {
        if (retryCount < 3) {
          const waitTime = Math.pow(2, retryCount) * 5000; // 5s, 10s, 20s
          console.warn(`Rate limit hit. Retrying in ${waitTime}ms... (Attempt ${retryCount + 1})`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          return analyzeScenario(dataUrl, retryCount + 1);
        }
      }
      console.error(err);
      throw err;
    }
  };

  const cropImage = (box: [number, number, number, number], sourceImageData: string): Promise<{ dataUrl: string, width: number, height: number }> => {
    return new Promise((resolve, reject) => {
      if (!sourceImageData) return resolve({ dataUrl: '', width: 0, height: 0 });
      
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          if (!ctx) return resolve({ dataUrl: '', width: 0, height: 0 });

          const [ymin, xmin, ymax, xmax] = box;
          
          const padding = 0;
          const pYmin = Math.max(0, ymin - padding);
          const pXmin = Math.max(0, xmin - padding);
          const pYmax = Math.min(1000, ymax + padding);
          const pXmax = Math.min(1000, xmax + padding);

          if (pYmax <= pYmin || pXmax <= pXmin) return resolve({ dataUrl: '', width: 0, height: 0 });

          const width = img.naturalWidth;
          const height = img.naturalHeight;

          const sx = (pXmin / 1000) * width;
          const sy = (pYmin / 1000) * height;
          const sw = ((pXmax - pXmin) / 1000) * width;
          const sh = ((pYmax - pYmin) / 1000) * height;

          if (sw <= 0 || sh <= 0) return resolve({ dataUrl: '', width: 0, height: 0 });

          canvas.width = sw;
          canvas.height = sh;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
          
          resolve({
            dataUrl: canvas.toDataURL('image/png'),
            width: sw,
            height: sh
          });
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = (e) => reject(new Error('画像の読み込みに失敗しました'));
      img.src = sourceImageData;
    });
  };

  const exportToExcel = async () => {
    if (results.length === 0) return;

    try {
      const workbook = new ExcelJS.Workbook();
      const usedSheetNames = new Set<string>();

      for (const resultItem of results) {
        const { data: result, imageData: sourceImageData } = resultItem;
        
        // Excel sheet name rules: max 31 chars, no / \ ? * [ ] : 
        const originalScenarioName = result.scenarioName || 'Scenario';
        let baseName = originalScenarioName
          .replace(/[/\\?%*:|[\]]/g, '-')
          .trim()
          .substring(0, 31);
        
        if (!baseName) baseName = 'Scenario';
        
        let sheetName = baseName;
        let counter = 1;
        while (usedSheetNames.has(sheetName)) {
          // If duplicate, we need to leave room for " (n)"
          const suffix = ` (${counter})`;
          sheetName = baseName.substring(0, 31 - suffix.length) + suffix;
          counter++;
        }
        usedSheetNames.add(sheetName);
        
        const worksheet = workbook.addWorksheet(sheetName);

        // Add metadata rows
        worksheet.getCell('A1').value = '実機での確認方法に関して';
        worksheet.getCell('A2').value = 'QRコードを読み取って、トーク画面内に自動入力されたコードを送信してください。';
        worksheet.getCell('A4').value = 'タイトル';
        worksheet.getCell('B4').value = result.scenarioName || originalScenarioName;
        worksheet.getCell('A5').value = '配信形式';
        worksheet.getCell('B5').value = result.deliveryFormat || '';
        worksheet.getCell('A6').value = '配信セグメント';
        worksheet.getCell('B6').value = result.deliverySegment || '';
        worksheet.getCell('A7').value = '配信日時';
        worksheet.getCell('B7').value = formatDateWithDay(result.deliveryDate || '');
        
        const hasReferenceSite = result.referenceSite !== undefined;
        if (hasReferenceSite) {
          worksheet.getCell('A8').value = '参考サイト';
          worksheet.getCell('B8').value = result.referenceSite || '';
        }
        
        // Style metadata labels and values
        const labelCells = ['A1', 'A4', 'A5', 'A6', 'A7'];
        if (hasReferenceSite) labelCells.push('A8');
        labelCells.forEach(cellId => {
          worksheet.getCell(cellId).font = { name: 'Meiryo' };
        });

        const valueCells = ['B4', 'B5', 'B6', 'B7'];
        if (hasReferenceSite) valueCells.push('B8');
        valueCells.forEach(cellId => {
          const cell = worksheet.getCell(cellId);
          cell.font = { name: 'Meiryo' };
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        });

        // Set row heights for metadata rows
        const metadataRows = [1, 2, 4, 5, 6, 7];
        if (hasReferenceSite) metadataRows.push(8);
        metadataRows.forEach(r => {
          worksheet.getRow(r).height = 52.5; // 70px
        });
        worksheet.getRow(3).height = 240; // 320px

        // Define columns
        worksheet.columns = [
          { key: 'type', width: 42 },
          { key: 'text', width: 80 },
        ];

        // Set default fonts for columns to handle emojis better
        worksheet.getColumn('type').font = { name: 'Meiryo', size: 10 };
        worksheet.getColumn('text').font = { name: 'Meiryo', size: 11 };

        // Set alignment for column A
        worksheet.getColumn(1).alignment = { vertical: 'middle', horizontal: 'left' };

        // Set headers
        const headerRowNumber = hasReferenceSite ? 9 : 8;
        const headerRow = worksheet.getRow(headerRowNumber);
        headerRow.getCell(1).value = '';
        headerRow.getCell(2).value = '会話内の文言/画像';
        
        // Style header
        headerRow.font = { name: 'Meiryo' };
        headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
        headerRow.getCell(2).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFD9E1F2' }
        };

        const getCircleNumber = (n: number) => {
          if (n >= 1 && n <= 20) {
            return String.fromCharCode(0x2460 + n - 1);
          }
          return `(${n})`;
        };

        const typeCounts: Record<string, number> = {};

        // Group horizontal images
        const groupedSteps: (ScenarioStep | ScenarioStep[])[] = [];
        for (let i = 0; i < result.steps.length; i++) {
          const step = result.steps[i];
          if (step.type === '画像' && step.imageBox) {
            const lastGroup = groupedSteps[groupedSteps.length - 1];
            if (Array.isArray(lastGroup)) {
              const firstInGroup = lastGroup[0];
              const [yMin1, , yMax1] = firstInGroup.imageBox!;
              const [yMin2, , yMax2] = step.imageBox!;
              
              const overlap = Math.min(yMax1, yMax2) - Math.max(yMin1, yMin2);
              const minHeight = Math.min(yMax1 - yMin1, yMax2 - yMin2);
              
              if (overlap > minHeight * 0.6) {
                lastGroup.push(step);
                lastGroup.sort((a, b) => (a.imageBox![1] - b.imageBox![1]));
                continue;
              }
            } else if (lastGroup && !Array.isArray(lastGroup) && lastGroup.type === '画像' && lastGroup.imageBox) {
              const [yMin1, , yMax1] = lastGroup.imageBox!;
              const [yMin2, , yMax2] = step.imageBox!;
              
              const overlap = Math.min(yMax1, yMax2) - Math.max(yMin1, yMin2);
              const minHeight = Math.min(yMax1 - yMin1, yMax2 - yMin2);
              
              if (overlap > minHeight * 0.6) {
                const newGroup = [lastGroup, step];
                newGroup.sort((a, b) => (a.imageBox![1] - b.imageBox![1]));
                groupedSteps[groupedSteps.length - 1] = newGroup;
                continue;
              }
            }
          }
          groupedSteps.push(step);
        }

        for (let i = 0; i < groupedSteps.length; i++) {
          const item = groupedSteps[i];
          const rowNumber = i + (hasReferenceSite ? 10 : 9);
          
          const firstStep = Array.isArray(item) ? item[0] : item;
          
          typeCounts[firstStep.type] = (typeCounts[firstStep.type] || 0) + 1;
          const displayType = `${firstStep.type}${getCircleNumber(typeCounts[firstStep.type])}`;

          let content = firstStep.text;
          if (firstStep.type === 'URL') {
            content = content.replace(/^Continue to URL:\s*/i, '');
          }

          const row = worksheet.addRow({
            type: displayType,
            text: Array.isArray(item) ? '' : content,
          });

          row.alignment = { vertical: 'middle', wrapText: true };
          // Set font to a standard one that handles emojis well in Japanese environments
          row.getCell('text').font = { name: 'Meiryo', size: 11 };
          row.getCell('type').font = { name: 'Meiryo', size: 10 };

          if (firstStep.type === 'URL') {
            const cell = row.getCell('text');
            cell.value = {
              text: content,
              hyperlink: content,
              tooltip: content
            };
            cell.font = { name: 'Meiryo', size: 11, color: { argb: 'FF0000FF' }, underline: true };
          }

          if (Array.isArray(item)) {
            const GAP_PX = 300;
            let currentXOffset = 0;
            let maxHeight = 0;
            let totalWidth = 0;

            for (let j = 0; j < item.length; j++) {
              const step = item[j];
              if (step.imageBox) {
                try {
                  const { dataUrl, width, height } = await cropImage(step.imageBox, sourceImageData);
                  if (dataUrl && dataUrl.includes(',')) {
                    const base64Part = dataUrl.split(',')[1];
                    const imageId = workbook.addImage({
                      base64: base64Part,
                      extension: 'png',
                    });

                    const targetHeight = height / 4;
                    const targetWidth = width / 4;

                    maxHeight = Math.max(maxHeight, targetHeight);
                    const nativeColOff = Math.round(currentXOffset * 9525);

                    worksheet.addImage(imageId, {
                      tl: { col: 1, row: rowNumber - 1, nativeColOff },
                      ext: { width: targetWidth, height: targetHeight },
                      editAs: 'oneCell'
                    });

                    currentXOffset += targetWidth + GAP_PX;
                    totalWidth = currentXOffset - GAP_PX;
                  }
                } catch (e) {
                  console.error('Failed to add image in group', e);
                }
              }
            }
            
            if (maxHeight > 0) {
              row.height = Math.min(409, maxHeight * 1.15);
              const neededWidth = totalWidth / 7;
              if (worksheet.getColumn(2).width < neededWidth) {
                worksheet.getColumn(2).width = neededWidth;
              }
            } else {
              row.height = 90;
            }
          } else if (item.hasImage && item.imageBox && item.type === '画像') {
            try {
              const { dataUrl, width, height } = await cropImage(item.imageBox, sourceImageData);
              if (dataUrl && dataUrl.includes(',')) {
                const base64Part = dataUrl.split(',')[1];
                if (base64Part) {
                  const imageId = workbook.addImage({
                    base64: base64Part,
                    extension: 'png',
                  });

                  const targetHeight = height / 4;
                  const targetWidth = width / 4;

                  row.height = Math.min(409, targetHeight * 1.15);

                  const neededWidth = targetWidth / 7;
                  if (worksheet.getColumn(2).width < neededWidth) {
                    worksheet.getColumn(2).width = neededWidth;
                  }

                  worksheet.addImage(imageId, {
                    tl: { col: 1, row: rowNumber - 1 },
                    ext: { width: targetWidth, height: targetHeight },
                    editAs: 'oneCell'
                  });
                }
              }
            } catch (e) {
              console.error('Failed to crop or add image', e);
              row.height = 90;
            }
          } else {
            // Calculate height based on text content to prevent cut-off
            const text = content || '';
            const lines = text.split('\n');
            let totalLines = 0;
            const charsPerLine = 60; // Estimate for Meiryo 11pt at column width 80

            lines.forEach(line => {
              // Estimate lines after wrapping
              totalLines += Math.max(1, Math.ceil(line.length / charsPerLine));
            });

            // Meiryo 11pt line height is approx 15-16 points. 
            // Using 18 points per line + 10 points padding for safety.
            const calculatedHeight = totalLines * 18 + 10;
            row.height = Math.min(409, Math.max(90, calculatedHeight));
          }
        }
      }

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = window.URL.createObjectURL(blob);
      
      const anchor = document.createElement('a');
      anchor.style.display = 'none';
      anchor.href = url;
      
      const fileName = customFileName.trim() || `Scenarios_${new Date().getTime()}`;
      anchor.download = `${fileName}.xlsx`;
      
      document.body.appendChild(anchor);
      anchor.click();
      
      setTimeout(() => {
        document.body.removeChild(anchor);
        window.URL.revokeObjectURL(url);
      }, 100);
    } catch (err) {
      console.error('Excel export error:', err);
      setError('Excelの作成中にエラーが発生しました。');
    }
  };

  const undo = useCallback(() => {
    if (history.length === 0) return;
    const previous = history[history.length - 1];
    setHistory(prev => prev.slice(0, -1));
    setResults(previous);
  }, [history]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        if (history.length > 0) {
          e.preventDefault();
          undo();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, history.length]);

  const deleteStep = (index: number) => {
    if (results.length === 0) return;
    setHistory(prev => [...prev, JSON.parse(JSON.stringify(results))]);
    const newResults = [...results];
    const currentResult = { ...newResults[activeResultIndex] };
    const newSteps = [...currentResult.data.steps];
    newSteps.splice(index, 1);
    currentResult.data = { ...currentResult.data, steps: newSteps };
    newResults[activeResultIndex] = currentResult;
    setResults(newResults);
  };

  const moveStep = (index: number, direction: 'up' | 'down') => {
    if (results.length === 0) return;
    const newResults = [...results];
    const currentResult = { ...newResults[activeResultIndex] };
    const newSteps = [...currentResult.data.steps];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    
    if (targetIndex < 0 || targetIndex >= newSteps.length) return;
    
    setHistory(prev => [...prev, JSON.parse(JSON.stringify(results))]);
    [newSteps[index], newSteps[targetIndex]] = [newSteps[targetIndex], newSteps[index]];
    currentResult.data = { ...currentResult.data, steps: newSteps };
    newResults[activeResultIndex] = currentResult;
    setResults(newResults);
  };

  const currentResult = results[activeResultIndex];

  const updateScenarioName = (newName: string) => {
    if (results.length === 0) return;
    const newResults = [...results];
    const currentResult = { ...newResults[activeResultIndex] };
    currentResult.data = { ...currentResult.data, scenarioName: newName };
    newResults[activeResultIndex] = currentResult;
    setResults(newResults);
  };

  const updateMetadata = (field: keyof ScenarioData, value: string | undefined) => {
    if (results.length === 0) return;
    const newResults = [...results];
    const currentResult = { ...newResults[activeResultIndex] };
    currentResult.data = { ...currentResult.data, [field]: value };
    newResults[activeResultIndex] = currentResult;
    setResults(newResults);
  };

  const formatDateWithDay = (dateStr: string) => {
    if (!dateStr) return '';
    if (dateStr === '調整中') return '調整中';
    
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;
    
    const days = ['日', '月', '火', '水', '木', '金', '土'];
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const dayOfWeek = days[date.getDay()];
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    
    return `${year}/${month}/${day}（${dayOfWeek}） ${hours}:${minutes}`;
  };

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] font-sans p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        {/* Hidden image for cropping */}
        {currentResult?.imageData && (
          <img 
            ref={imageRef} 
            src={currentResult.imageData} 
            className="hidden" 
            alt="Original for cropping" 
            onLoad={() => console.log('Image loaded for cropping')}
            referrerPolicy="no-referrer"
          />
        )}

        {/* Header */}
        <header className="mb-12 text-center">
          <motion.div 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="inline-flex items-center justify-center w-16 h-16 bg-white rounded-2xl shadow-sm border border-black/5 mb-4"
          >
            <FileSpreadsheet className="w-8 h-8 text-emerald-600" />
          </motion.div>
          <motion.h1 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.1 }}
            className="text-3xl font-bold tracking-tight mb-2"
          >
            シナリオ解析エクセル出力
          </motion.h1>
          <motion.p 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="text-gray-500"
          >
            PDFや画像のシナリオフローをAIが解析し、画像付きのExcelデータを作成します。
          </motion.p>
        </header>

        <div className="flex flex-col gap-8">
          {/* Top Section: Upload */}
          <section className="bg-white rounded-3xl p-8 shadow-sm border border-black/5">
            <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">
              <Upload className="w-6 h-6 text-emerald-500" />
              ファイルのアップロード
            </h2>
            
            <div 
              {...getRootProps()} 
              className={`
                border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all mb-6
                ${isDragActive ? 'border-emerald-500 bg-emerald-50' : 'border-gray-200 hover:border-emerald-400 hover:bg-gray-50'}
                ${isAnalyzing ? 'opacity-50 pointer-events-none' : ''}
              `}
            >
              <input {...getInputProps()} />
              <div className="flex flex-col items-center">
                <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
                  <ImageIcon className="w-8 h-8 text-gray-400" />
                </div>
                <p className="text-base font-medium text-gray-700">
                  クリックまたはドラッグ＆ドロップでファイルを追加
                </p>
                <p className="text-xs text-gray-400 mt-2">
                  PNG, JPG, PDF (最大10MB)
                </p>
              </div>
            </div>

            {selectedFiles.length > 0 && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-4"
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-gray-500 uppercase tracking-wider">選択中のファイル ({selectedFiles.length})</h3>
                  <button 
                    onClick={() => setSelectedFiles([])}
                    className="text-xs text-red-500 hover:text-red-600 font-medium"
                  >
                    すべて削除
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {selectedFiles.map((file, idx) => (
                    <div key={idx} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl border border-gray-100 group">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center shadow-sm shrink-0">
                          {file.type === 'application/pdf' ? <FileText className="w-4 h-4 text-red-500" /> : <ImageIcon className="w-4 h-4 text-blue-500" />}
                        </div>
                        <span className="text-sm font-medium text-gray-700 truncate">{file.name}</span>
                      </div>
                      <button 
                        onClick={(e) => { e.stopPropagation(); removeSelectedFile(idx); }}
                        className="p-1.5 text-gray-400 hover:text-red-500 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="pt-4">
                  <button
                    onClick={handleStartAnalysis}
                    disabled={isAnalyzing}
                    className="w-full py-4 bg-emerald-600 text-white rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-200 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none text-lg"
                  >
                    {isAnalyzing ? (
                      <>
                        <Loader2 className="w-6 h-6 animate-spin" />
                        解析中...
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="w-6 h-6" />
                        解析を開始する
                      </>
                    )}
                  </button>
                </div>
              </motion.div>
            )}
          </section>

          {/* Bottom Section: Results */}
          <div className="space-y-6">
            <AnimatePresence mode="wait">
              {results.length === 0 && !isAnalyzing && !error && (
                <motion.div 
                  key="empty"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-col items-center justify-center text-center p-20 bg-white rounded-3xl border border-dashed border-gray-200"
                >
                  <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-6">
                    <TableIcon className="w-10 h-10 text-gray-300" />
                  </div>
                  <p className="text-gray-400 font-medium text-lg">解析結果がここに表示されます</p>
                </motion.div>
              )}

              {isAnalyzing && (
                <motion.div 
                  key="loading"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-col items-center justify-center text-center p-20 bg-white rounded-3xl border border-black/5"
                >
                  <Loader2 className="w-16 h-16 text-emerald-500 animate-spin mb-6" />
                  <p className="text-xl text-gray-600 font-medium">AIがシナリオを読み取っています...</p>
                  <p className="text-sm text-gray-400 mt-3">画像抽出と解析を行っています。しばらくお待ちください。</p>
                </motion.div>
              )}

              {error && (
                <motion.div 
                  key="error"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="p-8 bg-red-50 rounded-3xl border border-red-100 flex items-start gap-6"
                >
                  <AlertCircle className="w-8 h-8 text-red-500 shrink-0" />
                  <div>
                    <p className="text-lg font-semibold text-red-900">エラーが発生しました</p>
                    <p className="text-red-700">{error}</p>
                  </div>
                </motion.div>
              )}

              {results.length > 0 && (
                <motion.div 
                  key="result"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-white rounded-3xl shadow-sm border border-black/5 overflow-hidden"
                >
                  <div className="p-8 border-b border-gray-100 flex flex-col gap-8 bg-gray-50/50">
                    {/* Top Row: Excel Filename and Export Button */}
                    <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-gray-200/60">
                      <div className="flex flex-col gap-2 flex-1 max-w-2xl">
                        <label className="text-xs font-bold text-gray-400 ml-1 uppercase tracking-wider">Excelファイル名</label>
                        <div className="relative">
                          <input 
                            type="text"
                            value={customFileName}
                            onChange={(e) => setCustomFileName(e.target.value)}
                            placeholder="Excelファイル名を入力"
                            className="w-full px-5 py-3.5 bg-white border border-gray-200 rounded-xl text-base focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none transition-all pr-16 font-semibold shadow-sm"
                          />
                          <span className="absolute right-5 top-1/2 -translate-y-1/2 text-gray-400 text-sm font-bold pointer-events-none">.xlsx</span>
                        </div>
                      </div>
                      <button
                        onClick={exportToExcel}
                        className="px-8 py-3.5 bg-emerald-600 text-white rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-200 active:scale-95 whitespace-nowrap text-lg"
                      >
                        <Download className="w-6 h-6" />
                        Excel出力
                      </button>
                    </div>

                    {/* Second Row: Scenario (Sheet) Name and Undo */}
                    <div className="flex flex-col gap-6">
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                        <div className="flex items-center gap-4 flex-1">
                          <div className="flex-1">
                            <label className="text-[10px] font-bold text-gray-400 ml-1 uppercase tracking-wider mb-1 block">現在のシート名 (A4セル: タイトル)</label>
                            <div className="relative group max-w-md">
                              <input 
                                type="text"
                                value={currentResult?.data.scenarioName || ''}
                                onChange={(e) => updateScenarioName(e.target.value)}
                                placeholder="シート名（シナリオ名）を入力"
                                className="text-xl font-bold text-gray-900 bg-white/50 border border-transparent hover:border-gray-300 focus:border-emerald-500 focus:bg-white px-3 py-1 pr-10 -ml-3 rounded-lg outline-none transition-all w-full"
                              />
                              <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-100 transition-opacity pointer-events-none">
                                <Edit3 className="w-4 h-4 text-emerald-500/70" />
                              </div>
                            </div>
                            <p className="text-sm text-gray-500 mt-1">{currentResult?.data.steps.length} ステップを検出しました</p>
                          </div>
                          {history.length > 0 && (
                            <button
                              onClick={undo}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:text-emerald-600 hover:border-emerald-200 transition-all shadow-sm"
                              title="元に戻す (Ctrl+Z)"
                            >
                              <Undo2 className="w-3.5 h-3.5" />
                              元に戻す
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Metadata Fields Row */}
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-4 border-t border-gray-100">
                        <div className="flex flex-col gap-2">
                          <label className="text-[10px] font-bold text-gray-400 ml-1 uppercase tracking-wider">A5セル: 配信形式</label>
                          <select
                            value={currentResult?.data.deliveryFormat || ''}
                            onChange={(e) => updateMetadata('deliveryFormat', e.target.value)}
                            className="w-full px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none transition-all shadow-sm"
                          >
                            <option value="">選択してください</option>
                            <option value="ショット配信">ショット配信</option>
                            <option value="トラック配信">トラック配信</option>
                          </select>
                        </div>
                        <div className="flex flex-col gap-2">
                          <label className="text-[10px] font-bold text-gray-400 ml-1 uppercase tracking-wider">A6セル: 配信セグメント</label>
                          <input 
                            type="text"
                            value={currentResult?.data.deliverySegment || ''}
                            onChange={(e) => updateMetadata('deliverySegment', e.target.value)}
                            placeholder="セグメントを入力"
                            className="w-full px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none transition-all shadow-sm"
                          />
                        </div>
                        <div className="flex flex-col gap-2">
                          <div className="flex items-center justify-between">
                            <label className="text-[10px] font-bold text-gray-400 ml-1 uppercase tracking-wider">A7セル: 配信日時</label>
                            <label className="flex items-center gap-1.5 cursor-pointer">
                              <input 
                                type="checkbox"
                                checked={currentResult?.data.deliveryDate === '調整中'}
                                onChange={(e) => updateMetadata('deliveryDate', e.target.checked ? '調整中' : '')}
                                className="w-3.5 h-3.5 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                              />
                              <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">調整中</span>
                            </label>
                          </div>
                          {currentResult?.data.deliveryDate === '調整中' ? (
                            <div className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-500 font-medium">
                              調整中
                            </div>
                          ) : (
                            <input 
                              type="datetime-local"
                              value={currentResult?.data.deliveryDate || ''}
                              onChange={(e) => updateMetadata('deliveryDate', e.target.value)}
                              className="w-full px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none transition-all shadow-sm"
                            />
                          )}
                        </div>

                        {/* Reference Site Field */}
                        <div className="flex flex-col gap-2">
                          <div className="flex items-center justify-between">
                            <label className="text-[10px] font-bold text-gray-400 ml-1 uppercase tracking-wider">A8セル: 参考サイト</label>
                            {currentResult?.data.referenceSite !== undefined ? (
                              <button 
                                onClick={() => updateMetadata('referenceSite', undefined)}
                                className="text-[10px] font-bold text-red-400 hover:text-red-600 uppercase tracking-wider flex items-center gap-1"
                              >
                                <Trash2 className="w-3 h-3" />
                                削除
                              </button>
                            ) : (
                              <button 
                                onClick={() => updateMetadata('referenceSite', '')}
                                className="text-[10px] font-bold text-emerald-500 hover:text-emerald-700 uppercase tracking-wider flex items-center gap-1"
                              >
                                <Edit3 className="w-3 h-3" />
                                追加
                              </button>
                            )}
                          </div>
                          {currentResult?.data.referenceSite !== undefined && (
                            <input 
                              type="text"
                              value={currentResult?.data.referenceSite || ''}
                              onChange={(e) => updateMetadata('referenceSite', e.target.value)}
                              placeholder="参考サイトのURLや名称を入力"
                              className="w-full px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none transition-all shadow-sm"
                            />
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Tab Selection for multiple results */}
                    <div className="flex flex-wrap gap-2">
                      {results.map((res, idx) => (
                        <button
                          key={idx}
                          onClick={() => setActiveResultIndex(idx)}
                          className={`
                            px-4 py-2 rounded-lg text-sm font-medium transition-all border max-w-[200px] truncate
                            ${activeResultIndex === idx 
                              ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm' 
                              : 'bg-white text-gray-600 border-gray-200 hover:border-emerald-200 hover:bg-emerald-50'}
                          `}
                          title={res.data.scenarioName || res.file.name}
                        >
                          {res.data.scenarioName || res.file.name}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse table-fixed">
                      <thead>
                        <tr className="bg-white border-b border-gray-100">
                          <th className="px-4 py-5 text-xs font-bold text-gray-400 uppercase tracking-wider text-center w-24">操作</th>
                          <th className="px-8 py-5 text-xs font-bold text-gray-400 uppercase tracking-wider w-40">タイプ</th>
                          <th className="px-8 py-5 text-xs font-bold text-gray-400 uppercase tracking-wider">内容 / 画像</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {currentResult?.data.steps.map((step, idx) => (
                          <tr key={idx} className="hover:bg-gray-50/30 transition-colors group">
                            <td className="px-4 py-6 align-top">
                              <div className="flex flex-col items-center gap-2">
                                <div className="flex flex-col gap-0.5">
                                  <button 
                                    onClick={() => moveStep(idx, 'up')}
                                    disabled={idx === 0}
                                    className="p-1 text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 rounded transition-colors disabled:opacity-10"
                                    title="上に移動"
                                  >
                                    <ChevronUp className="w-3.5 h-3.5" />
                                  </button>
                                  <button 
                                    onClick={() => moveStep(idx, 'down')}
                                    disabled={idx === (currentResult?.data.steps.length || 0) - 1}
                                    className="p-1 text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 rounded transition-colors disabled:opacity-10"
                                    title="下に移動"
                                  >
                                    <ChevronDown className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                                <button 
                                  onClick={() => deleteStep(idx)}
                                  className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                                  title="削除"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            </td>
                            <td className="px-8 py-6 align-top">
                              <span className={`
                                text-[10px] font-bold uppercase px-3 py-1.5 rounded-full inline-block
                                ${step.type === 'テキスト' ? 'bg-blue-50 text-blue-600' : 
                                  step.type === '画像' ? 'bg-purple-50 text-purple-600' : 
                                  step.type === 'オルトテキスト' ? 'bg-emerald-50 text-emerald-600' : 
                                  step.type === 'URL' ? 'bg-orange-50 text-orange-600' :
                                  'bg-gray-50 text-gray-600'}
                              `}>
                                {step.type}
                              </span>
                            </td>
                            <td className="px-8 py-6 align-top">
                              {step.text && <p className="text-base text-gray-700 mb-3 leading-relaxed">{step.text}</p>}
                              {step.type === '画像' && step.hasImage && step.imageBox && currentResult?.imageData && (
                                <StepImage box={step.imageBox} imageData={currentResult.imageData} />
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="p-8 bg-emerald-50/30 flex items-center gap-4 border-t border-gray-100">
                    <div className="w-10 h-10 bg-emerald-100 rounded-full flex items-center justify-center">
                      <CheckCircle2 className="w-6 h-6 text-emerald-600" />
                    </div>
                    <p className="text-emerald-900 font-medium">
                      解析が完了しました。上記の表で内容を確認し、Excelボタンからダウンロードしてください。
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Footer Info */}
      <footer className="mt-12 text-center text-gray-400 text-xs">
        <p>© 2026 Scenario Parser Tool • Powered by Gemini AI</p>
      </footer>
    </div>
  );
}
