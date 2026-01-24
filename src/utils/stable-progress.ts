/**
 * Stable progress window implementation using zotero-plugin-toolkit
 * This replaces the crashing native implementation
 */

import { ProgressWindowHelper } from 'zotero-plugin-toolkit';
import { Logger } from './logger';

declare const Services: any;

// Set default icon for all progress windows
ProgressWindowHelper.setIconURI(
  'default',
  `chrome://zotseek/content/icons/favicon.png`
);

export interface StableProgressOptions {
  title: string;
  closeOnClick?: boolean;
  cancelCallback?: () => void;
}

/**
 * Stable progress window that doesn't crash or resize
 */
export class StableProgressWindow {
  private progressWindow: any;
  private logger: Logger;
  private cancelled = false;
  private cancelCallback?: () => void;
  private currentLine: any;
  private startTime: number;
  private title: string;
  
  constructor(options: StableProgressOptions) {
    this.logger = new Logger('StableProgress');
    this.title = options.title;
    this.cancelCallback = options.cancelCallback;
    this.startTime = Date.now();
    
    try {
      // Create the progress window with toolkit
      this.progressWindow = new ProgressWindowHelper(options.title, {
        closeOnClick: options.closeOnClick ?? false,
        closeTime: -1, // Don't auto-close
      });
      
      // Create initial progress line
      this.currentLine = this.progressWindow.createLine({
        text: 'Initializing...',
        type: 'default',
        progress: 0,
      });
      
      // Show the window
      this.progressWindow.show();

      // Resize the window to be taller (Zotero's default is too short for multiple status lines)
      // and try to make it not always on top
      this.resizeWindow(350, 320);
      this.adjustWindowLevel();

      this.logger.debug(`Progress window created: ${options.title}`);
    } catch (error) {
      this.logger.error('Failed to create progress window:', error);
      // Fall back to console logging
      this.useFallback();
    }
  }
  
  /**
   * Update progress with text and percentage
   */
  updateProgress(text: string, percent?: number | null, additionalInfo?: string[]): void {
    if (this.cancelled) return;
    
    try {
      // Build the full text
      let fullText = text;
      if (additionalInfo && additionalInfo.length > 0) {
        fullText += '\n' + additionalInfo.join('\n');
      }
      
      // Update the progress line
      if (this.progressWindow && this.currentLine) {
        this.progressWindow.changeLine({
          text: fullText,
          progress: percent ?? 0,
        });
      } else {
        // Fallback to logging
        this.logger.info(`Progress: ${fullText} (${percent ?? 0}%)`);
      }
    } catch (error) {
      this.logger.error('Failed to update progress:', error);
      this.useFallback();
    }
  }
  
  /**
   * Set headline (title) of the progress window
   */
  setHeadline(text: string): void {
    if (this.cancelled) return;
    
    try {
      // Toolkit doesn't have changeHeadline, so we update the line text
      this.updateProgress(text, null);
    } catch (error) {
      this.logger.error('Failed to set headline:', error);
    }
  }
  
  /**
   * Add a status line with optional icon
   */
  addLine(text: string, icon?: 'chrome://zotero/skin/tick.png' | 'chrome://zotero/skin/cross.png'): void {
    if (this.cancelled) return;
    
    try {
      // Determine type based on icon
      let type: 'default' | 'success' | 'fail' = 'default';
      if (icon?.includes('tick')) {
        type = 'success';
      } else if (icon?.includes('cross')) {
        type = 'fail';
      }
      
      // Create a new line for status messages
      if (this.progressWindow) {
        this.progressWindow.createLine({
          text,
          type,
          progress: 100,
        });
      } else {
        this.logger.info(`Status: ${text}`);
      }
    } catch (error) {
      this.logger.error('Failed to add line:', error);
    }
  }
  
  /**
   * Complete the progress with success message
   */
  complete(message?: string, autoClose = true): void {
    if (this.cancelled) return;
    
    try {
      if (this.progressWindow) {
        // Update to success state
        this.progressWindow.changeLine({
          text: message || 'Complete!',
          type: 'success',
          progress: 100,
        });
        
        // Auto-close after delay (15 seconds to allow reading stats)
        if (autoClose) {
          this.progressWindow.startCloseTimer(15000);
        }
      } else {
        this.logger.info(`Complete: ${message || 'Done'}`);
      }
    } catch (error) {
      this.logger.error('Failed to complete progress:', error);
    }
  }
  
  /**
   * Show error and optionally close
   */
  error(message: string, autoClose = false): void {
    try {
      if (this.progressWindow) {
        // Update to error state
        this.progressWindow.changeLine({
          text: message,
          type: 'fail',
          progress: 100,
        });
        
        // Keep error visible longer
        if (autoClose) {
          this.progressWindow.startCloseTimer(8000);
        }
      } else {
        this.logger.error(`Error shown: ${message}`);
      }
    } catch (error) {
      this.logger.error('Failed to show error:', error);
    }
  }
  
  /**
   * Close the progress window
   */
  close(): void {
    try {
      if (this.progressWindow) {
        this.progressWindow.close();
        this.logger.debug('Progress window closed');
      }
    } catch (error) {
      this.logger.error('Failed to close progress window:', error);
    }
  }
  
  /**
   * Check if cancelled
   */
  isCancelled(): boolean {
    return this.cancelled;
  }
  
  /**
   * Cancel the operation
   */
  cancel(): void {
    this.cancelled = true;
    this.logger.info('Progress cancelled by user');
    
    if (this.cancelCallback) {
      this.cancelCallback();
    }
    
    this.close();
  }
  
  /**
   * Fallback to console logging
   */
  private useFallback(): void {
    this.logger.warn('Using console logging fallback for progress');
    this.progressWindow = null;
  }

  /**
   * Resize the progress window to accommodate more status lines
   */
  private resizeWindow(width: number, height: number): void {
    try {
      // Find and resize the progress window
      const windows = (Services as any).wm.getEnumerator(null);
      while (windows.hasMoreElements()) {
        const win = windows.getNext();
        if (win.document?.title === 'Progress') {
          win.resizeTo(width, height);
          this.logger.debug(`Resized progress window to ${width}x${height}`);
          break;
        }
      }
    } catch (error) {
      this.logger.debug('Could not resize progress window:', error);
    }
  }

  /**
   * Try to make the progress window not always on top
   */
  private adjustWindowLevel(): void {
    try {
      const windows = (Services as any).wm.getEnumerator(null);
      while (windows.hasMoreElements()) {
        const win = windows.getNext();
        if (win.document?.title === 'Progress') {
          // Try to lower the window level so it doesn't float above all apps
          // Note: This may not work on all platforms
          if (win.document?.documentElement) {
            win.document.documentElement.setAttribute('level', 'normal');
          }
          this.logger.debug('Adjusted progress window level');
          break;
        }
      }
    } catch (error) {
      this.logger.debug('Could not adjust window level:', error);
    }
  }
  
  /**
   * Calculate and format ETA
   */
  formatETA(current: number, total: number): string {
    if (current === 0) return '';
    
    const elapsed = Date.now() - this.startTime;
    const avgTimePerItem = elapsed / current;
    const remaining = total - current;
    const etaMs = remaining * avgTimePerItem;
    
    const etaMin = Math.floor(etaMs / 60000);
    const etaSec = Math.floor((etaMs % 60000) / 1000);
    
    return etaMin > 0 ? `${etaMin}m ${etaSec}s` : `${etaSec}s`;
  }
  
  /**
   * Update with ETA calculation
   */
  updateProgressWithETA(text: string, current: number, total: number): void {
    const percent = Math.round((current / total) * 100);
    const eta = this.formatETA(current, total);
    
    const additionalInfo = [
      `${current}/${total} items`,
      eta ? `ETA: ${eta}` : ''
    ].filter(Boolean);
    
    this.updateProgress(text, percent, additionalInfo);
  }
}

/**
 * Quick notification helper
 */
export function showQuickNotification(
  message: string,
  type: 'default' | 'success' | 'fail' = 'default',
  duration = 5000
): void {
  try {
    new ProgressWindowHelper('Semantic Search')
      .createLine({
        text: message,
        type,
        progress: 100,
      })
      .show(duration);
  } catch (error) {
    console.error('Failed to show notification:', error);
  }
}
