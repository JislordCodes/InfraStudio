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
    // reset input
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
        className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-md shadow transition-colors"
      >
        <Upload className="w-4 h-4" />
        Load IFC Model
      </button>
    </>
  );
};
