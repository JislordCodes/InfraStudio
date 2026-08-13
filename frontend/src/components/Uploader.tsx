import React, { useRef } from 'react';
import { Upload } from 'lucide-react';

interface UploaderProps {
  onFileUpload: (file: File) => void;
}

export const Uploader: React.FC<UploaderProps> = ({ onFileUpload }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (file.name.toLowerCase().endsWith('.ifc')) {
         onFileUpload(file);
      } else {
         alert("Please select a valid .ifc file");
      }
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <>
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept=".ifc"
        className="hidden"
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        className="flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-4 py-1.5 sm:py-2 bg-blue-600 hover:bg-blue-500 active:scale-95 text-white text-xs sm:text-sm font-medium rounded-lg shadow-md transition-all shrink-0"
        title="Upload local IFC file"
      >
        <Upload className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
        <span className="hidden sm:inline">Load IFC Model</span>
        <span className="sm:hidden font-medium">Upload</span>
      </button>
    </>
  );
};
