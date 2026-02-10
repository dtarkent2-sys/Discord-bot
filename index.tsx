await import('./index.js');
} catch (error) {
  console.error('Failed to load index.js:', error);
  process.exit(1);
}
